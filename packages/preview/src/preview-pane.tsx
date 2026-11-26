import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { PreviewAdapter, PreviewFrameController, PreviewFrameEvent } from "@shaulavo/workbench-core";
import { useSubscribable } from "@shaulavo/workbench-core/react";
import { cx } from "@shaulavo/workbench-ui";
import { normalizePreviewPath } from "./controllers";

export type PreviewViewportPreset = "responsive" | "tablet" | "mobile";

export interface PreviewPaneProps {
  readonly adapter: PreviewAdapter;
  readonly initialPath?: string;
  readonly viewportPreset?: PreviewViewportPreset;
  readonly onViewportPresetChange?: (preset: PreviewViewportPreset) => void;
  /** Disables iframe pointer events with an overlay shield while a parent splitter is dragging. */
  readonly dragging?: boolean;
  readonly sandbox?: string;
  readonly allow?: string;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly actions?: ReactNode;
  readonly onConsole?: (entry: { readonly level: "log" | "warn" | "error"; readonly text: string }) => void;
  readonly onFrameError?: (message: string) => void;
  readonly className?: string;
}

const VIEWPORT_OPTIONS: readonly {
  readonly id: PreviewViewportPreset;
  readonly label: string;
}[] = [
  { id: "responsive", label: "Full" },
  { id: "tablet", label: "768" },
  { id: "mobile", label: "390" },
];

function safeExternalHref(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return trimmed;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Backend-agnostic live preview pane over `PreviewAdapter` + `PreviewFrameController`.
 * Supports both bridged per-document `hello` handshakes (Sprockt) and bridge-less remote previews
 * (Fregat / cloud sandboxes), with port switching, URL bar navigation, back/forward/reload,
 * open-in-tab, responsive viewport presets, and an iframe pointer-events drag shield.
 */
export function PreviewPane({
  adapter,
  initialPath = "/",
  viewportPreset: controlledViewport,
  onViewportPresetChange,
  dragging = false,
  sandbox,
  allow,
  emptyTitle = "No preview server running",
  emptyDescription = "Start a dev server in the terminal to preview your app here.",
  actions,
  onConsole,
  onFrameError,
  className,
}: PreviewPaneProps) {
  const servers = useSubscribable(adapter.servers);
  const [bootState, setBootState] = useState<{
    readonly adapter: PreviewAdapter;
    readonly ready: boolean;
    readonly error: string | null;
  }>(() => ({
    adapter,
    ready: adapter.kind === "none" || servers.length > 0,
    error: null,
  }));
  const [selectedPort, setSelectedPort] = useState<number | undefined>(() => servers[0]?.port);
  const [committedPath, setCommittedPath] = useState(() => normalizePreviewPath(initialPath));
  const [pathDraft, setPathDraft] = useState(() => normalizePreviewPath(initialPath));
  const [bridgeState, setBridgeState] = useState<{
    readonly key: string;
    readonly status: "pending" | "bridged" | "bridgeless";
    readonly title: string;
    readonly error: string | null;
  }>({ key: "", status: "pending", title: "", error: null });
  const [internalViewport, setInternalViewport] = useState<PreviewViewportPreset>("responsive");

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const controllerRef = useRef<PreviewFrameController | null>(null);
  const editingPathRef = useRef(false);
  const committedPathRef = useRef(normalizePreviewPath(initialPath));

  const emitConsole = useEffectEvent(
    (entry: { readonly level: "log" | "warn" | "error"; readonly text: string }) => {
      onConsole?.(entry);
    },
  );
  const emitFrameError = useEffectEvent((message: string) => {
    onFrameError?.(message);
  });

  const activeServer = servers.find((srv) => srv.port === selectedPort) ?? servers[0];
  const activePort = activeServer?.port;
  const viewportPreset = controlledViewport ?? internalViewport;
  const adapterReady =
    bootState.adapter === adapter ? bootState.ready : adapter.kind === "none" || servers.length > 0;
  const bootError = bootState.adapter === adapter ? bootState.error : null;
  const sessionKey = `${adapter.kind}:${activePort ?? "none"}`;
  const effectiveBridgeStatus = bridgeState.key === sessionKey ? bridgeState.status : "pending";
  const frameTitle = bridgeState.key === sessionKey ? bridgeState.title : "";
  const frameError = bridgeState.key === sessionKey ? bridgeState.error : null;

  useEffect(() => {
    let cancelled = false;
    void adapter
      .whenReady()
      .then(() => {
        if (!cancelled) setBootState({ adapter, ready: true, error: null });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "Preview runtime failed to start";
        setBootState({ adapter, ready: false, error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !adapterReady || bootError || activePort === undefined) {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      return;
    }

    const handleEvent = (event: PreviewFrameEvent): void => {
      if (event.type === "bridge-ready") {
        setBridgeState((prev) => ({
          key: sessionKey,
          status: event.supported ? "bridged" : "bridgeless",
          title: prev.key === sessionKey ? prev.title : "",
          error: prev.key === sessionKey ? prev.error : null,
        }));
        return;
      }
      if (event.type === "started" || event.type === "navigate") {
        const nextPath = normalizePreviewPath(event.location.path);
        committedPathRef.current = nextPath;
        setCommittedPath(nextPath);
        if (!editingPathRef.current) setPathDraft(nextPath);
        setBridgeState((prev) => ({
          key: sessionKey,
          status: prev.key === sessionKey ? prev.status : "pending",
          title: prev.key === sessionKey ? prev.title : "",
          error: null,
        }));
        return;
      }
      if (event.type === "title") {
        setBridgeState((prev) => ({
          key: sessionKey,
          status: prev.key === sessionKey ? prev.status : "pending",
          title: event.title,
          error: prev.key === sessionKey ? prev.error : null,
        }));
        return;
      }
      if (event.type === "console") {
        emitConsole({ level: event.level, text: event.text });
        return;
      }
      if (event.type === "error") {
        setBridgeState((prev) => ({
          key: sessionKey,
          status: prev.key === sessionKey ? prev.status : "pending",
          title: prev.key === sessionKey ? prev.title : "",
          error: event.message,
        }));
        emitFrameError(event.message);
      }
    };

    const controller = adapter.attachFrame(frame, activePort, handleEvent);
    controllerRef.current = controller;
    const initialSrc = adapter.frameUrl(activePort, committedPathRef.current);
    // Always assign frame.src on controller attach so StrictMode remounts trigger a fresh load + handshake.
    frame.src = initialSrc;

    const stopReload = adapter.onReloadNeeded?.(() => {
      controller.reload();
    });

    return () => {
      stopReload?.();
      controller.dispose();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [adapter, adapterReady, bootError, activePort, sessionKey]);

  function setViewport(next: PreviewViewportPreset): void {
    if (onViewportPresetChange) onViewportPresetChange(next);
    else setInternalViewport(next);
  }

  function handleNavigateSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = normalizePreviewPath(pathDraft, (href) => adapter.locate(href));
    committedPathRef.current = normalized;
    setCommittedPath(normalized);
    setPathDraft(normalized);
    editingPathRef.current = false;
    controllerRef.current?.navigate(normalized);
  }

  const openTabHref =
    activePort !== undefined ? safeExternalHref(adapter.tabUrl(activePort, committedPath)) : undefined;

  return (
    <section
      data-wb-preview=""
      data-preview-kind={adapter.kind}
      data-bridge-state={effectiveBridgeStatus}
      data-viewport-preset={viewportPreset}
      aria-label={frameTitle ? `Preview: ${frameTitle}` : "Preview"}
      className={cx("wb-preview-pane", className)}
    >
      <div className="wb-preview-toolbar">
        <div className="wb-preview-nav-group">
          <button
            type="button"
            className="wb-preview-btn"
            aria-label="Back"
            title="Back"
            data-testid="wb-preview-back"
            disabled={activePort === undefined}
            onClick={() => controllerRef.current?.back()}
          >
            ←
          </button>
          <button
            type="button"
            className="wb-preview-btn"
            aria-label="Forward"
            title="Forward"
            data-testid="wb-preview-forward"
            disabled={activePort === undefined}
            onClick={() => controllerRef.current?.forward()}
          >
            →
          </button>
          <button
            type="button"
            className="wb-preview-btn"
            aria-label="Reload preview"
            title="Reload preview"
            data-testid="wb-preview-reload"
            disabled={activePort === undefined}
            onClick={() => controllerRef.current?.reload()}
          >
            ↻
          </button>
        </div>

        {servers.length > 1 ? (
          <select
            aria-label="Preview server port"
            className="wb-preview-port-select"
            data-testid="wb-preview-port-select"
            value={activePort ?? ""}
            onChange={(event) => {
              const nextPort = Number(event.target.value);
              if (!Number.isFinite(nextPort)) return;
              committedPathRef.current = "/";
              setCommittedPath("/");
              setPathDraft("/");
              setSelectedPort(nextPort);
            }}
          >
            {servers.map((srv) => (
              <option key={srv.port} value={srv.port}>
                {srv.label ? `${srv.label} (:${srv.port})` : `:${srv.port}`}
              </option>
            ))}
          </select>
        ) : activeServer ? (
          <span className="wb-preview-port-badge" data-testid="wb-preview-port-badge">
            {activeServer.label ? `${activeServer.label} :${activeServer.port}` : `:${activeServer.port}`}
          </span>
        ) : null}

        <form className="wb-preview-url-form" onSubmit={handleNavigateSubmit}>
          <input
            type="text"
            aria-label="Preview URL path"
            className="wb-preview-url-input"
            data-testid="wb-preview-url-input"
            value={pathDraft}
            disabled={activePort === undefined}
            onFocus={() => {
              editingPathRef.current = true;
            }}
            onBlur={() => {
              editingPathRef.current = false;
            }}
            onChange={(event) => setPathDraft(event.target.value)}
          />
        </form>

        <div className="wb-preview-viewport-group" role="group" aria-label="Viewport size">
          {VIEWPORT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className="wb-preview-btn"
              aria-pressed={viewportPreset === opt.id}
              data-active={viewportPreset === opt.id ? "true" : undefined}
              data-testid={`wb-preview-viewport-${opt.id}`}
              onClick={() => setViewport(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {openTabHref ? (
          <a
            href={openTabHref}
            target="_blank"
            rel="noopener noreferrer"
            className="wb-preview-btn wb-preview-external"
            aria-label="Open preview in new tab"
            title="Open preview in new tab"
            data-testid="wb-preview-open-tab"
          >
            ↗
          </a>
        ) : null}
        {actions}
      </div>

      {frameError ? (
        <div className="wb-preview-banner-error" role="alert" data-testid="wb-preview-error">
          {frameError}
        </div>
      ) : null}

      <div className="wb-preview-stage" data-viewport-preset={viewportPreset}>
        {bootError ? (
          <div className="wb-preview-state" role="alert" data-testid="wb-preview-boot-error">
            <strong>Preview failed to start</strong>
            <p>{bootError}</p>
          </div>
        ) : !adapterReady ? (
          <div className="wb-preview-state" role="status" data-testid="wb-preview-booting">
            <span>Starting preview…</span>
          </div>
        ) : activePort === undefined ? (
          <div className="wb-preview-state" data-testid="wb-preview-empty">
            <strong>{emptyTitle}</strong>
            <p>{emptyDescription}</p>
          </div>
        ) : (
          <div className="wb-preview-frame-wrap" data-viewport-preset={viewportPreset}>
            <iframe
              ref={frameRef}
              title={frameTitle || `Preview :${activePort}`}
              className="wb-preview-iframe"
              data-testid="wb-preview-iframe"
              sandbox={sandbox}
              allow={allow}
              onLoad={() => controllerRef.current?.onFrameLoad()}
            />
            {dragging ? (
              <div
                className="wb-preview-drag-shield"
                data-testid="wb-preview-drag-shield"
                aria-hidden="true"
              />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
