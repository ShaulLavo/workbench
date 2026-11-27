import type { PreviewFrameController, PreviewFrameEvent, PreviewLocation } from "@shaulavo/workbench-core";

export const DEFAULT_PREVIEW_BRIDGE_CHANNEL = "wb:preview:v1";

/** Normalizes a user-entered preview path so it always starts with `/` and preserves query/hash. */
export function normalizePreviewPath(
  raw: string,
  locate?: (href: string) => PreviewLocation | undefined,
): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  if (/^https?:\/\//i.test(trimmed)) {
    const located = locate?.(trimmed);
    if (located) return normalizePreviewPath(located.path);
    try {
      const parsed = new URL(trimmed);
      return `${parsed.pathname || "/"}${parsed.search}${parsed.hash}`;
    } catch {
      return "/";
    }
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export interface BridgelessPreviewControllerOptions {
  readonly frame: HTMLIFrameElement;
  readonly port: number;
  readonly frameUrl: (port: number, path: string) => string;
  readonly initialPath?: string;
  readonly onEvent: (event: PreviewFrameEvent) => void;
}

function isOpaqueSandboxedFrame(frame: HTMLIFrameElement): boolean {
  const sandboxAttr = frame.getAttribute("sandbox");
  if (sandboxAttr === null) return false;
  return !sandboxAttr.split(/\s+/).includes("allow-same-origin");
}

/**
 * Bridge-less `PreviewFrameController` for remote sandboxes, localhost URLs, or cross-origin
 * dev servers where no script is injected into the preview document.
 */
export function createBridgelessPreviewController({
  frame,
  port,
  frameUrl,
  initialPath = "/",
  onEvent,
}: BridgelessPreviewControllerOptions): PreviewFrameController {
  let disposed = false;
  const history: string[] = [normalizePreviewPath(initialPath)];
  let cursor = 0;

  function loadUrl(path: string): void {
    if (disposed) return;
    frame.src = frameUrl(port, path);
    onEvent({ type: "navigate", location: { port, path } });
  }

  return {
    onFrameLoad() {
      if (disposed) return;
      onEvent({ type: "bridge-ready", supported: false });
      if (isOpaqueSandboxedFrame(frame)) return;
      try {
        const title = frame.contentDocument?.title;
        if (title) onEvent({ type: "title", title });
      } catch {
        // Cross-origin frames disallow contentDocument access; title remains optional.
      }
    },
    navigate(rawPath) {
      if (disposed) return;
      const next = normalizePreviewPath(rawPath);
      if (history[cursor] !== next) {
        history.splice(cursor + 1);
        history.push(next);
        cursor = history.length - 1;
      }
      loadUrl(next);
    },
    reload() {
      if (disposed) return;
      const current = history[cursor] ?? "/";
      if (!isOpaqueSandboxedFrame(frame)) {
        try {
          if (frame.contentWindow && frame.contentDocument) {
            frame.contentWindow.location.reload();
            return;
          }
        } catch {
          // Cross-origin frame: fall back to reassigning frame.src below.
        }
      }
      frame.src = frameUrl(port, current);
    },
    back() {
      if (disposed || cursor <= 0) return;
      cursor -= 1;
      const target = history[cursor] ?? "/";
      loadUrl(target);
    },
    forward() {
      if (disposed || cursor >= history.length - 1) return;
      cursor += 1;
      const target = history[cursor] ?? "/";
      loadUrl(target);
    },
    canGoBack() {
      return !disposed && cursor > 0;
    },
    canGoForward() {
      return !disposed && cursor < history.length - 1;
    },
    dispose() {
      disposed = true;
    },
  };
}

export interface PreviewBridgeControllerOptions {
  readonly frame: HTMLIFrameElement;
  readonly port: number;
  readonly frameUrl: (port: number, path: string) => string;
  /** Exact expected origin for incoming postMessages (`"*"` is rejected unless `"null"` for opaque srcdoc). */
  readonly expectedOrigin: string;
  readonly channel?: string;
  readonly initialPath?: string;
  readonly onEvent: (event: PreviewFrameEvent) => void;
}

interface BridgeIncomingMessage {
  readonly channel?: unknown;
  readonly type?: unknown;
  readonly token?: unknown;
  readonly path?: unknown;
  readonly title?: unknown;
  readonly level?: unknown;
  readonly text?: unknown;
  readonly message?: unknown;
}

let globalHandshakeSeq = 0;

function createHandshakeToken(port: number): string {
  globalHandshakeSeq += 1;
  const nonce =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `wb-hello-${port}-${globalHandshakeSeq}-${nonce}`;
}

function isConsoleLevel(value: unknown): value is "log" | "warn" | "error" {
  return value === "log" || value === "warn" || value === "error";
}

/**
 * Bridged `PreviewFrameController` implementing a per-document `hello` handshake, strict
 * `event.source === frame.contentWindow` and `event.origin === expectedOrigin` validation, and
 * automatic `frame.src` fallback before a document completes the handshake.
 */
export function createPreviewBridgeController({
  frame,
  port,
  frameUrl,
  expectedOrigin,
  channel = DEFAULT_PREVIEW_BRIDGE_CHANNEL,
  initialPath = "/",
  onEvent,
}: PreviewBridgeControllerOptions): PreviewFrameController {
  if (!expectedOrigin || expectedOrigin === "*") {
    throw new Error("createPreviewBridgeController requires an explicit expectedOrigin (never '*')");
  }
  let disposed = false;
  let bridgeReady = false;
  let activeToken: string | null = null;
  let currentPath = normalizePreviewPath(initialPath);
  const targetOrigin = expectedOrigin === "null" ? "*" : expectedOrigin;

  function postToFrame(payload: Record<string, unknown>): boolean {
    if (disposed || !frame.contentWindow || activeToken === null) return false;
    frame.contentWindow.postMessage({ channel, token: activeToken, ...payload }, targetOrigin);
    return true;
  }

  function handleMessage(event: MessageEvent): void {
    if (disposed || activeToken === null) return;
    if (event.source !== frame.contentWindow) return;
    if (event.origin !== expectedOrigin) return;
    const data = event.data as BridgeIncomingMessage | null;
    if (!data || typeof data !== "object" || data.channel !== channel) return;

    if (data.type === "hello-ack") {
      if (typeof data.token !== "string" || data.token !== activeToken) return;
      bridgeReady = true;
      onEvent({ type: "bridge-ready", supported: true });
      if (typeof data.path === "string") {
        currentPath = normalizePreviewPath(data.path);
        onEvent({ type: "started", location: { port, path: currentPath } });
      }
      if (typeof data.title === "string" && data.title) {
        onEvent({ type: "title", title: data.title });
      }
      return;
    }

    if (!bridgeReady || data.token !== activeToken) return;

    if (data.type === "navigate" && typeof data.path === "string") {
      currentPath = normalizePreviewPath(data.path);
      onEvent({ type: "navigate", location: { port, path: currentPath } });
      return;
    }
    if (data.type === "title" && typeof data.title === "string") {
      onEvent({ type: "title", title: data.title });
      return;
    }
    if (data.type === "console" && isConsoleLevel(data.level) && typeof data.text === "string") {
      onEvent({ type: "console", level: data.level, text: data.text });
      return;
    }
    if (data.type === "error" && typeof data.message === "string") {
      onEvent({ type: "error", message: data.message });
    }
  }

  window.addEventListener("message", handleMessage);

  return {
    onFrameLoad() {
      if (disposed) return;
      bridgeReady = false;
      activeToken = createHandshakeToken(port);
      postToFrame({ type: "hello", port });
    },
    navigate(rawPath) {
      if (disposed) return;
      const next = normalizePreviewPath(rawPath);
      currentPath = next;
      if (bridgeReady && postToFrame({ type: "navigate", path: next })) {
        return;
      }
      frame.src = frameUrl(port, next);
      onEvent({ type: "navigate", location: { port, path: next } });
    },
    reload() {
      if (disposed) return;
      if (bridgeReady && postToFrame({ type: "reload" })) return;
      frame.src = frameUrl(port, currentPath);
    },
    back() {
      if (disposed) return;
      if (bridgeReady) postToFrame({ type: "back" });
    },
    forward() {
      if (disposed) return;
      if (bridgeReady) postToFrame({ type: "forward" });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      bridgeReady = false;
      window.removeEventListener("message", handleMessage);
    },
  };
}
