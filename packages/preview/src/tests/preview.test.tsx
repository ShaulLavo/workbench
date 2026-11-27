import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  PreviewAdapter,
  PreviewFrameEvent,
  PreviewServerInfo,
  Subscribable,
} from "@shaulavo/workbench-core";
import { WorkbenchPortalProvider } from "@shaulavo/workbench-ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBridgelessPreviewController,
  createPreviewBridgeController,
  DEFAULT_PREVIEW_BRIDGE_CHANNEL,
  DEFAULT_PREVIEW_SANDBOX,
  normalizePreviewPath,
  PreviewPane,
} from "../index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let activeRoot: Root | null = null;
let activeHost: HTMLDivElement | null = null;

function createSubscribable<T>(initial: T): Subscribable<T> & { set(next: T): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

function mount(element: React.ReactElement): HTMLDivElement {
  activeHost = document.createElement("div");
  document.body.appendChild(activeHost);
  activeRoot = createRoot(activeHost);
  act(() => {
    activeRoot?.render(<WorkbenchPortalProvider>{element}</WorkbenchPortalProvider>);
  });
  return activeHost;
}

afterEach(() => {
  act(() => {
    activeRoot?.unmount();
  });
  activeRoot = null;
  activeHost?.remove();
  activeHost = null;
});

describe("@shaulavo/workbench-preview", () => {
  it("normalizes relative paths, query strings, and full URLs", () => {
    expect(normalizePreviewPath("")).toBe("/");
    expect(normalizePreviewPath("about?tab=1#top")).toBe("/about?tab=1#top");
    expect(normalizePreviewPath("http://127.0.0.1:5173/docs/intro?x=1")).toBe("/docs/intro?x=1");
    expect(normalizePreviewPath("https://custom.local/app", () => ({ port: 3000, path: "custom" }))).toBe(
      "/custom",
    );
  });

  it("tracks history and emits bridge-ready:false in bridge-less controller", () => {
    const frame = document.createElement("iframe");
    const events: PreviewFrameEvent[] = [];
    const controller = createBridgelessPreviewController({
      frame,
      port: 3000,
      frameUrl: (port, p) => `http://127.0.0.1:${port}${p}`,
      onEvent: (event) => events.push(event),
    });

    controller.onFrameLoad();
    expect(events).toContainEqual({ type: "bridge-ready", supported: false });

    controller.navigate("/page-1");
    controller.navigate("/page-2");
    expect(frame.getAttribute("src")).toBe("http://127.0.0.1:3000/page-2");

    controller.back();
    expect(frame.getAttribute("src")).toBe("http://127.0.0.1:3000/page-1");
    controller.forward();
    expect(frame.getAttribute("src")).toBe("http://127.0.0.1:3000/page-2");
    controller.dispose();
  });

  it("validates source, origin, and per-load token in bridged preview controller", () => {
    const posted: { readonly payload: Record<string, unknown>; readonly origin: string }[] = [];
    const mockWindow = {
      postMessage(payload: Record<string, unknown>, origin: string) {
        posted.push({ payload, origin });
      },
    } as unknown as Window;

    const frame = document.createElement("iframe");
    Object.defineProperty(frame, "contentWindow", { value: mockWindow, configurable: true });

    const events: PreviewFrameEvent[] = [];
    const controller = createPreviewBridgeController({
      frame,
      port: 5173,
      frameUrl: (port, p) => `http://localhost:${port}${p}`,
      expectedOrigin: "http://localhost:5173",
      onEvent: (event) => events.push(event),
    });

    // Empty-token hello-ack arriving BEFORE onFrameLoad() must be rejected.
    window.dispatchEvent(
      new MessageEvent("message", {
        source: mockWindow,
        origin: "http://localhost:5173",
        data: { channel: DEFAULT_PREVIEW_BRIDGE_CHANNEL, type: "hello-ack", token: "" },
      }),
    );
    expect(events).toHaveLength(0);

    controller.onFrameLoad();
    expect(posted).toHaveLength(1);
    const token = posted[0]?.payload.token as string;
    expect(token).toContain("wb-hello-5173-");

    // Wrong origin must be rejected.
    window.dispatchEvent(
      new MessageEvent("message", {
        source: mockWindow,
        origin: "https://evil.example",
        data: { channel: DEFAULT_PREVIEW_BRIDGE_CHANNEL, type: "hello-ack", token },
      }),
    );
    expect(events).toHaveLength(0);

    // Wrong source must be rejected.
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "http://localhost:5173",
        data: { channel: DEFAULT_PREVIEW_BRIDGE_CHANNEL, type: "hello-ack", token },
      }),
    );
    expect(events).toHaveLength(0);

    // Valid hello-ack completes handshake.
    window.dispatchEvent(
      new MessageEvent("message", {
        source: mockWindow,
        origin: "http://localhost:5173",
        data: {
          channel: DEFAULT_PREVIEW_BRIDGE_CHANNEL,
          type: "hello-ack",
          token,
          path: "/dashboard",
          title: "Dashboard",
        },
      }),
    );
    expect(events).toContainEqual({ type: "bridge-ready", supported: true });
    expect(events).toContainEqual({
      type: "started",
      location: { port: 5173, path: "/dashboard" },
    });
    expect(events).toContainEqual({ type: "title", title: "Dashboard" });

    // Message missing token must be rejected even after bridge is ready.
    window.dispatchEvent(
      new MessageEvent("message", {
        source: mockWindow,
        origin: "http://localhost:5173",
        data: { channel: DEFAULT_PREVIEW_BRIDGE_CHANNEL, type: "navigate", path: "/spoofed" },
      }),
    );
    expect(events.some((e) => e.type === "navigate" && e.location.path === "/spoofed")).toBe(false);

    // Bridged navigate sends postMessage with token instead of resetting frame.src.
    controller.navigate("/settings");
    expect(posted.at(-1)?.payload).toMatchObject({
      channel: DEFAULT_PREVIEW_BRIDGE_CHANNEL,
      type: "navigate",
      path: "/settings",
      token,
    });
    controller.dispose();

    // Replacing the controller on the same iframe + port mints a distinct token and rejects old acks.
    const events2: PreviewFrameEvent[] = [];
    const controller2 = createPreviewBridgeController({
      frame,
      port: 5173,
      frameUrl: (port, p) => `http://localhost:${port}${p}`,
      expectedOrigin: "http://localhost:5173",
      onEvent: (event) => events2.push(event),
    });
    controller2.onFrameLoad();
    const token2 = posted.at(-1)?.payload.token as string;
    expect(token2).not.toBe(token);
    window.dispatchEvent(
      new MessageEvent("message", {
        source: mockWindow,
        origin: "http://localhost:5173",
        data: { channel: DEFAULT_PREVIEW_BRIDGE_CHANNEL, type: "hello-ack", token },
      }),
    );
    expect(events2).toHaveLength(0);
    controller2.dispose();
  });

  it("sandboxes preview iframes by default and preserves non-root initialPath across Back and Reload", async () => {
    const servers = createSubscribable<readonly PreviewServerInfo[]>([{ port: 5173, label: "web" }]);
    const adapter: PreviewAdapter = {
      kind: "mounted",
      servers,
      whenReady: async () => {},
      frameUrl: (port, p) => `http://127.0.0.1:${port}${p}`,
      tabUrl: (port, p) => `http://127.0.0.1:${port}${p}`,
      locate: () => undefined,
      attachFrame: (el, port, onEvent, options) =>
        createBridgelessPreviewController({
          frame: el,
          port,
          frameUrl: (p, path) => `http://127.0.0.1:${p}${path}`,
          initialPath: options?.initialPath,
          onEvent,
        }),
    };

    const host = mount(<PreviewPane adapter={adapter} initialPath="/start" />);
    await act(async () => {
      await Promise.resolve();
    });

    const iframe = host.querySelector<HTMLIFrameElement>('[data-testid="wb-preview-iframe"]');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe(DEFAULT_PREVIEW_SANDBOX);
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe?.getAttribute("src")).toBe("http://127.0.0.1:5173/start");

    // Opaque sandboxed frames must NEVER read contentDocument on frame load or reload (avoids WebKit pageerror).
    const contentDocSpy = vi.fn(() => {
      throw new Error("cross-origin");
    });
    Object.defineProperty(iframe, "contentDocument", {
      get: contentDocSpy,
      configurable: true,
    });
    act(() => {
      iframe?.dispatchEvent(new Event("load"));
    });
    expect(contentDocSpy).not.toHaveBeenCalled();

    // Cross-origin reload before any toolbar navigation must keep /start without touching contentDocument.
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="wb-preview-reload"]')?.click();
    });
    expect(contentDocSpy).not.toHaveBeenCalled();
    expect(iframe?.getAttribute("src")).toBe("http://127.0.0.1:5173/start");

    // Navigate to /next then press Back -> returns to /start (not /).
    const urlInput = host.querySelector<HTMLInputElement>('[data-testid="wb-preview-url-input"]');
    const form = host.querySelector<HTMLFormElement>(".wb-preview-url-form");
    act(() => {
      if (urlInput) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(urlInput, "/next");
        urlInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(iframe?.getAttribute("src")).toBe("http://127.0.0.1:5173/next");

    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="wb-preview-back"]')?.click();
    });
    expect(iframe?.getAttribute("src")).toBe("http://127.0.0.1:5173/start");
  });

  it("rejects wildcard expectedOrigin and strips unsafe open-in-tab URL schemes", async () => {
    const frame = document.createElement("iframe");
    expect(() =>
      createPreviewBridgeController({
        frame,
        port: 5173,
        frameUrl: (port, p) => `http://localhost:${port}${p}`,
        expectedOrigin: "*",
        onEvent: () => {},
      }),
    ).toThrow(/expectedOrigin/);

    const servers = createSubscribable<readonly PreviewServerInfo[]>([{ port: 5173, label: "web" }]);
    const unsafeAdapter: PreviewAdapter = {
      kind: "remote",
      servers,
      whenReady: async () => {},
      frameUrl: (port, p) => `http://127.0.0.1:${port}${p}`,
      tabUrl: () => "javascript:alert(1)",
      locate: () => undefined,
      attachFrame: (el, port, onEvent) =>
        createBridgelessPreviewController({
          frame: el,
          port,
          frameUrl: (p, path) => `http://127.0.0.1:${p}${path}`,
          onEvent,
        }),
    };

    const host = mount(<PreviewPane adapter={unsafeAdapter} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="wb-preview-open-tab"]')).toBeNull();
  });

  it("renders PreviewPane states, switches ports, submits URL bar, and mounts drag shield", async () => {
    const servers = createSubscribable<readonly PreviewServerInfo[]>([
      { port: 5173, label: "web" },
      { port: 4000, label: "api" },
    ]);
    const navigated: { readonly port: number; readonly path: string }[] = [];
    const reloadListeners = new Set<() => void>();
    const reloadSpy = vi.fn();

    const adapter: PreviewAdapter = {
      kind: "remote",
      servers,
      whenReady: async () => {},
      frameUrl: (port, p) => `http://127.0.0.1:${port}${p}`,
      tabUrl: (port, p) => `http://127.0.0.1:${port}${p}`,
      locate: () => undefined,
      attachFrame(frame, port, onEvent) {
        const inner = createBridgelessPreviewController({
          frame,
          port,
          frameUrl: (p, path) => `http://127.0.0.1:${p}${path}`,
          onEvent,
        });
        return {
          ...inner,
          navigate(path) {
            navigated.push({ port, path });
            inner.navigate(path);
          },
          reload() {
            reloadSpy(port);
            inner.reload();
          },
        };
      },
      onReloadNeeded(listener) {
        reloadListeners.add(listener);
        return () => reloadListeners.delete(listener);
      },
    };

    const host = mount(<PreviewPane adapter={adapter} dragging />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="wb-preview-drag-shield"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="wb-preview-open-tab"]')?.getAttribute("href")).toBe(
      "http://127.0.0.1:5173/",
    );

    const urlInput = host.querySelector<HTMLInputElement>('[data-testid="wb-preview-url-input"]');
    const form = host.querySelector<HTMLFormElement>(".wb-preview-url-form");
    act(() => {
      if (urlInput) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(urlInput, "pricing?plan=pro");
        urlInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(navigated).toContainEqual({ port: 5173, path: "/pricing?plan=pro" });

    // Switch viewport preset to mobile 390px.
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="wb-preview-viewport-mobile"]')?.click();
    });
    expect(host.querySelector("[data-wb-preview]")?.getAttribute("data-viewport-preset")).toBe("mobile");

    // Reload notification triggers active controller reload.
    for (const listener of reloadListeners) listener();
    expect(reloadSpy).toHaveBeenCalledWith(5173);

    // Clearing servers shows empty state.
    act(() => {
      servers.set([]);
    });
    expect(host.querySelector('[data-testid="wb-preview-empty"]')).not.toBeNull();
  });

  it("supports sandbox={null}, accurate Back/Forward disabled states, toggleable error lists, and custom slots", async () => {
    const servers = createSubscribable<readonly PreviewServerInfo[]>([{ port: 3000 }]);
    let emitFrameEvent: ((event: PreviewFrameEvent) => void) | undefined;
    const navigated: string[] = [];
    const openedUrls: string[] = [];
    const reportedPorts: (number | undefined)[] = [];

    const adapter: PreviewAdapter = {
      kind: "mounted",
      servers,
      whenReady: async () => {},
      frameUrl: (port, path) => `http://127.0.0.1:${port}${path}`,
      tabUrl: (port, path) => `http://127.0.0.1:${port}${path}`,
      locate: () => undefined,
      attachFrame(_frame, _port, onEvent) {
        emitFrameEvent = onEvent;
        return {
          onFrameLoad: () => {},
          navigate: (path) => navigated.push(path),
          reload: () => {},
          back: () => {},
          forward: () => {},
          dispose: () => {},
        };
      },
    };

    const host = mount(
      <PreviewPane
        adapter={adapter}
        sandbox={null}
        allow="cross-origin-isolated"
        errorDisplay="toggle"
        historyMode="pane"
        alwaysShowPortSelect
        banner={<div data-testid="custom-banner">Restart held</div>}
        toolbarTrailing={
          <button type="button" data-testid="custom-task">
            Start
          </button>
        }
        onOpenInTab={(url) => openedUrls.push(url)}
        onActivePortChange={(port) => reportedPorts.push(port)}
        renderEmpty={() => <div data-testid="custom-empty">Custom empty</div>}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const iframe = host.querySelector<HTMLIFrameElement>('[data-testid="wb-preview-iframe"]');
    expect(iframe?.hasAttribute("sandbox")).toBe(false);
    expect(iframe?.getAttribute("allow")).toBe("cross-origin-isolated");
    expect(host.querySelector('[data-testid="wb-preview-port-select"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="custom-banner"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="custom-task"]')).not.toBeNull();
    expect(reportedPorts.at(-1)).toBe(3000);

    const backBtn = host.querySelector<HTMLButtonElement>('[data-testid="wb-preview-back"]')!;
    const forwardBtn = host.querySelector<HTMLButtonElement>('[data-testid="wb-preview-forward"]')!;
    expect(backBtn.disabled).toBe(true);
    expect(forwardBtn.disabled).toBe(true);

    // Frame reports navigation to /about -> Back enables, Forward stays disabled.
    act(() => {
      emitFrameEvent?.({ type: "navigate", location: { port: 3000, path: "/about" } });
    });
    expect(backBtn.disabled).toBe(false);
    expect(forwardBtn.disabled).toBe(true);

    // Back navigates to "/" in pane history mode and enables Forward.
    act(() => {
      backBtn.click();
    });
    expect(navigated.at(-1)).toBe("/");
    expect(backBtn.disabled).toBe(true);
    expect(forwardBtn.disabled).toBe(false);

    // Frame errors accumulate in toggleable list and clear on started.
    act(() => {
      emitFrameEvent?.({ type: "error", message: "kaboom" });
    });
    const errorToggle = host.querySelector<HTMLButtonElement>('[data-testid="wb-preview-errors"]');
    expect(errorToggle?.textContent).toBe("1");
    act(() => {
      errorToggle?.click();
    });
    expect(host.querySelector('[data-testid="wb-preview-error-list"]')?.textContent).toContain("kaboom");

    act(() => {
      emitFrameEvent?.({ type: "started", location: { port: 3000, path: "/" } });
    });
    expect(host.querySelector('[data-testid="wb-preview-errors"]')).toBeNull();

    // Open in tab button calls callback.
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="wb-preview-open-tab"]')?.click();
    });
    expect(openedUrls).toEqual(["http://127.0.0.1:3000/"]);

    // Clearing servers renders custom empty state.
    act(() => {
      servers.set([]);
    });
    expect(host.querySelector('[data-testid="custom-empty"]')).not.toBeNull();
  });
});
