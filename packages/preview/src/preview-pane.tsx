import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import type {
  PreviewAdapter,
  PreviewFrameController,
  PreviewFrameEvent,
  PreviewServerInfo,
} from "@shaulavo/workbench-core";
import { useSubscribable } from "@shaulavo/workbench-core/react";
import { cx } from "@shaulavo/workbench-ui";
import { normalizePreviewPath } from "./controllers";

export type PreviewViewportPreset = "responsive" | "tablet" | "mobile";

/**
 * Default iframe sandbox omitting `allow-same-origin` so same-origin mounted previews stay
 * isolated in an opaque origin and cannot read or modify the workbench DOM.
 */
export const DEFAULT_PREVIEW_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

const ERROR_HISTORY_LIMIT = 50;

interface PreviewHistoryState {
  readonly key: string;
  readonly entries: readonly string[];
  readonly index: number;
}

function createInitialHistory(key: string, initialPath: string): PreviewHistoryState {
  return { key, entries: [initialPath], index: 0 };
}

function recordHistoryVisit(prev: PreviewHistoryState, key: string, path: string): PreviewHistoryState {
  if (prev.key !== key) return createInitialHistory(key, path);
  if (prev.entries[prev.index] === path) return prev;
  const nextEntries = prev.entries.slice(0, prev.index + 1).concat([path]);
  return { key, entries: nextEntries, index: nextEntries.length - 1 };
}

function replaceHistoryVisit(prev: PreviewHistoryState, key: string, path: string): PreviewHistoryState {
  if (prev.key !== key) return createInitialHistory(key, path);
  if (prev.entries[prev.index] === path) return prev;
  const nextEntries = prev.entries.slice(0, prev.index).concat([path], prev.entries.slice(prev.index + 1));
  return { key, entries: nextEntries, index: prev.index };
}

export interface PreviewPaneProps {
  readonly adapter: PreviewAdapter;
  readonly initialPath?: string;
  readonly viewportPreset?: PreviewViewportPreset;
  readonly onViewportPresetChange?: (preset: PreviewViewportPreset) => void;
  /** Disables iframe pointer events with an overlay shield while a parent splitter is dragging. */
  readonly dragging?: boolean;
  /** Pass `null` to omit the `sandbox` attribute (e.g. for cross-origin-isolated service-worker/subdomain previews). */
  readonly sandbox?: string | null;
  readonly allow?: string;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly renderEmpty?: (state: {
    readonly booting: boolean;
    readonly bootError: string | null;
  }) => ReactNode;
  readonly banner?: ReactNode;
  readonly actions?: ReactNode;
  /** Rendered pinned outside the scrollable toolbar region, alongside Open-in-tab. */
  readonly toolbarTrailing?: ReactNode;
  readonly toolbarScrollRef?: RefCallback<HTMLDivElement>;
  /** When `"toggle"`, accumulates frame errors into a collapsible toolbar counter + list. */
  readonly errorDisplay?: "banner" | "toggle";
  /** When `"pane"`, Back/Forward steer via `controller.navigate(target)` from pane history. */
  readonly historyMode?: "controller" | "pane";
  /** Always render a `<select>` port picker whenever at least one server is running. */
  readonly alwaysShowPortSelect?: boolean;
  readonly hideViewportsWhenEmpty?: boolean;
  readonly formatPortLabel?: (server: PreviewServerInfo) => string;
  readonly urlLabel?: string;
  readonly viewportLabels?: {
    readonly responsive?: string;
    readonly tablet?: string;
    readonly mobile?: string;
  };
  readonly renderViewportIcon?: (preset: PreviewViewportPreset) => ReactNode;
  readonly openInTabLabel?: string;
  readonly onOpenInTab?: (url: string) => void;
  readonly onActivePortChange?: (port: number | undefined) => void;
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
  sandbox = DEFAULT_PREVIEW_SANDBOX,
  allow,
  emptyTitle = "No preview server running",
  emptyDescription = "Start a dev server in the terminal to preview your app here.",
  renderEmpty,
  banner,
  actions,
  toolbarTrailing,
  toolbarScrollRef,
  errorDisplay = "banner",
  historyMode = "controller",
  alwaysShowPortSelect = false,
  hideViewportsWhenEmpty = false,
  formatPortLabel,
  urlLabel = "Preview URL path",
  viewportLabels,
  renderViewportIcon,
  openInTabLabel = "Open preview in new tab",
  onOpenInTab,
  onActivePortChange,
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
  const normalizedInitial = normalizePreviewPath(initialPath);
  const [committedPath, setCommittedPath] = useState(normalizedInitial);
  const [pathDraft, setPathDraft] = useState(normalizedInitial);
  const [bridgeState, setBridgeState] = useState<{
    readonly key: string;
    readonly status: "pending" | "bridged" | "bridgeless";
    readonly title: string;
    readonly error: string | null;
    readonly errors: readonly string[];
  }>({ key: "", status: "pending", title: "", error: null, errors: [] });
  const [historyState, setHistoryState] = useState<PreviewHistoryState>(() =>
    createInitialHistory("", normalizedInitial),
  );
  const [controllerNav, setControllerNav] = useState<{
    readonly key: string;
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
  }>({ key: "", canGoBack: true, canGoForward: true });
  const [showErrors, setShowErrors] = useState(false);
  const [internalViewport, setInternalViewport] = useState<PreviewViewportPreset>("responsive");

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const controllerRef = useRef<PreviewFrameController | null>(null);
  const editingPathRef = useRef(false);
  const committedPathRef = useRef(normalizedInitial);
  const lastAttachedPortRef = useRef<number | undefined>(undefined);

  const emitConsole = useEffectEvent(
    (entry: { readonly level: "log" | "warn" | "error"; readonly text: string }) => {
      onConsole?.(entry);
    },
  );
  const emitFrameError = useEffectEvent((message: string) => {
    onFrameError?.(message);
  });
  const emitActivePort = useEffectEvent((port: number | undefined) => {
    onActivePortChange?.(port);
  });

  const activeServer = servers.find((srv) => srv.port === selectedPort) ?? servers[0];
  const activePort = activeServer?.port;
  const [trackedPort, setTrackedPort] = useState<number | undefined>(activePort);
  if (trackedPort !== activePort) {
    const hadPreviousPort = trackedPort !== undefined;
    setTrackedPort(activePort);
    if (activePort !== undefined && selectedPort !== activePort) {
      setSelectedPort(activePort);
    }
    if (hadPreviousPort) {
      const resetPath = activePort === undefined ? normalizedInitial : "/";
      setCommittedPath(resetPath);
      setPathDraft(resetPath);
    }
  }
  const viewportPreset = controlledViewport ?? internalViewport;
  const adapterReady =
    bootState.adapter === adapter ? bootState.ready : adapter.kind === "none" || servers.length > 0;
  const bootError = bootState.adapter === adapter ? bootState.error : null;
  const sessionKey = `${adapter.kind}:${activePort ?? "none"}`;
  const effectiveBridgeStatus = bridgeState.key === sessionKey ? bridgeState.status : "pending";
  const frameTitle = bridgeState.key === sessionKey ? bridgeState.title : "";
  const frameError = bridgeState.key === sessionKey ? bridgeState.error : null;
  const frameErrors = bridgeState.key === sessionKey ? bridgeState.errors : [];
  const activeHistory =
    historyState.key === sessionKey ? historyState : createInitialHistory(sessionKey, committedPath);
  const canGoBack =
    activePort !== undefined &&
    (historyMode === "pane"
      ? activeHistory.index > 0
      : controllerNav.key === sessionKey
        ? controllerNav.canGoBack
        : true);
  const canGoForward =
    activePort !== undefined &&
    (historyMode === "pane"
      ? activeHistory.index < activeHistory.entries.length - 1
      : controllerNav.key === sessionKey
        ? controllerNav.canGoForward
        : true);

  useEffect(() => {
    emitActivePort(activePort);
  }, [activePort]);

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
      if (activePort === undefined) {
        lastAttachedPortRef.current = undefined;
        committedPathRef.current = normalizedInitial;
      }
      return;
    }

    const syncControllerNav = (ctrl: PreviewFrameController | null): void => {
      if (!ctrl) return;
      setControllerNav({
        key: sessionKey,
        canGoBack: ctrl.canGoBack ? ctrl.canGoBack() : true,
        canGoForward: ctrl.canGoForward ? ctrl.canGoForward() : true,
      });
    };

    const handleEvent = (event: PreviewFrameEvent): void => {
      if (event.type === "bridge-ready") {
        setBridgeState((prev) => ({
          key: sessionKey,
          status: event.supported ? "bridged" : "bridgeless",
          title: prev.key === sessionKey ? prev.title : "",
          error: prev.key === sessionKey ? prev.error : null,
          errors: prev.key === sessionKey ? prev.errors : [],
        }));
        syncControllerNav(controllerRef.current);
        return;
      }
      if (event.type === "started" || event.type === "navigate") {
        const nextPath = normalizePreviewPath(event.location.path);
        committedPathRef.current = nextPath;
        setCommittedPath(nextPath);
        if (!editingPathRef.current) setPathDraft(nextPath);
        if (historyMode === "pane") {
          const replace = event.type === "navigate" && event.replace === true;
          setHistoryState((prev) =>
            replace
              ? replaceHistoryVisit(prev, sessionKey, nextPath)
              : recordHistoryVisit(prev, sessionKey, nextPath),
          );
        } else {
          syncControllerNav(controllerRef.current);
        }
        setBridgeState((prev) => ({
          key: sessionKey,
          status: prev.key === sessionKey ? prev.status : "pending",
          title: prev.key === sessionKey ? prev.title : "",
          error: null,
          errors: event.type === "started" ? [] : prev.key === sessionKey ? prev.errors : [],
        }));
        return;
      }
      if (event.type === "title") {
        setBridgeState((prev) => ({
          key: sessionKey,
          status: prev.key === sessionKey ? prev.status : "pending",
          title: event.title,
          error: prev.key === sessionKey ? prev.error : null,
          errors: prev.key === sessionKey ? prev.errors : [],
        }));
        return;
      }
      if (event.type === "console") {
        emitConsole({ level: event.level, text: event.text });
        return;
      }
      if (event.type === "error") {
        setBridgeState((prev) => {
          const baseErrors = prev.key === sessionKey ? prev.errors : [];
          return {
            key: sessionKey,
            status: prev.key === sessionKey ? prev.status : "pending",
            title: prev.key === sessionKey ? prev.title : "",
            error: event.message,
            errors: baseErrors.concat([event.message]).slice(-ERROR_HISTORY_LIMIT),
          };
        });
        emitFrameError(event.message);
      }
    };

    const switchedPort =
      lastAttachedPortRef.current !== undefined && lastAttachedPortRef.current !== activePort;
    lastAttachedPortRef.current = activePort;
    const initialFramePath = switchedPort ? "/" : committedPathRef.current;
    if (switchedPort) {
      committedPathRef.current = "/";
      editingPathRef.current = false;
    }
    if (historyMode === "pane") {
      setHistoryState(createInitialHistory(sessionKey, initialFramePath));
    }
    setShowErrors(false);
    const controller = adapter.attachFrame(frame, activePort, handleEvent, {
      initialPath: initialFramePath,
    });
    controllerRef.current = controller;
    syncControllerNav(controller);
    const initialSrc = adapter.frameUrl(activePort, initialFramePath);
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
  }, [adapter, adapterReady, bootError, activePort, sessionKey, historyMode, normalizedInitial]);

  function setViewport(next: PreviewViewportPreset): void {
    if (onViewportPresetChange) onViewportPresetChange(next);
    else setInternalViewport(next);
  }

  function stepHistory(delta: -1 | 1): void {
    if (historyMode === "pane") {
      const nextIndex = activeHistory.index + delta;
      const target = activeHistory.entries[nextIndex];
      if (target === undefined) return;
      setHistoryState({ key: sessionKey, entries: activeHistory.entries, index: nextIndex });
      committedPathRef.current = target;
      setCommittedPath(target);
      if (!editingPathRef.current) setPathDraft(target);
      controllerRef.current?.navigate(target);
      return;
    }
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    if (delta < 0) ctrl.back();
    else ctrl.forward();
    setControllerNav({
      key: sessionKey,
      canGoBack: ctrl.canGoBack ? ctrl.canGoBack() : true,
      canGoForward: ctrl.canGoForward ? ctrl.canGoForward() : true,
    });
  }

  function handleNavigateSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = normalizePreviewPath(pathDraft, (href) => adapter.locate(href));
    committedPathRef.current = normalized;
    setCommittedPath(normalized);
    setPathDraft(normalized);
    if (historyMode === "pane") {
      setHistoryState((prev) => recordHistoryVisit(prev, sessionKey, normalized));
    }
    editingPathRef.current = false;
    const ctrl = controllerRef.current;
    ctrl?.navigate(normalized);
    if (historyMode !== "pane" && ctrl) {
      setControllerNav({
        key: sessionKey,
        canGoBack: ctrl.canGoBack ? ctrl.canGoBack() : true,
        canGoForward: ctrl.canGoForward ? ctrl.canGoForward() : true,
      });
    }
  }

  const openTabHref =
    activePort !== undefined && adapterReady
      ? safeExternalHref(adapter.tabUrl(activePort, committedPath))
      : undefined;

  const portOptionText = (srv: PreviewServerInfo): string => {
    if (formatPortLabel) return formatPortLabel(srv);
    return srv.label ? `${srv.label} (:${srv.port})` : `:${srv.port}`;
  };

  const showPortSelect = alwaysShowPortSelect ? servers.length > 0 : servers.length > 1;
  const showViewports = !hideViewportsWhenEmpty || activePort !== undefined;

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
        <div ref={toolbarScrollRef} className="wb-preview-toolbar-scroll" data-fade="">
          <div className="wb-preview-nav-group">
            <button
              type="button"
              className="wb-preview-btn"
              aria-label="Back"
              title="Back"
              data-testid="wb-preview-back"
              disabled={!canGoBack}
              onClick={() => stepHistory(-1)}
            >
              ←
            </button>
            <button
              type="button"
              className="wb-preview-btn"
              aria-label="Forward"
              title="Forward"
              data-testid="wb-preview-forward"
              disabled={!canGoForward}
              onClick={() => stepHistory(1)}
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

          {showPortSelect ? (
            <select
              aria-label="Preview server port"
              className="wb-preview-port-select"
              data-testid="wb-preview-port-select"
              value={activePort ?? ""}
              onChange={(event) => {
                const nextPort = Number(event.target.value);
                if (!Number.isFinite(nextPort)) return;
                setSelectedPort(nextPort);
              }}
            >
              {servers.map((srv) => (
                <option key={srv.port} value={srv.port}>
                  {portOptionText(srv)}
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
              aria-label={urlLabel}
              className="wb-preview-url-input"
              data-testid="wb-preview-url-input"
              spellCheck={false}
              autoComplete="off"
              value={activePort === undefined ? "" : pathDraft}
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

          {showViewports ? (
            <div className="wb-preview-viewport-group" role="group" aria-label="Viewport size">
              {VIEWPORT_OPTIONS.map((opt) => {
                const ariaLabel = viewportLabels?.[opt.id];
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className="wb-preview-btn"
                    aria-label={ariaLabel}
                    aria-pressed={viewportPreset === opt.id}
                    data-active={viewportPreset === opt.id ? "true" : undefined}
                    data-testid={`wb-preview-viewport-${opt.id}`}
                    onClick={() => setViewport(opt.id)}
                  >
                    {renderViewportIcon ? renderViewportIcon(opt.id) : opt.label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {errorDisplay === "toggle" && frameErrors.length > 0 ? (
            <button
              type="button"
              className="wb-preview-btn wb-preview-errors-toggle"
              data-testid="wb-preview-errors"
              aria-expanded={showErrors}
              aria-label={`Preview errors (${frameErrors.length})`}
              onClick={() => setShowErrors((shown) => !shown)}
            >
              <span>{frameErrors.length}</span>
            </button>
          ) : null}
        </div>

        <div className="wb-preview-toolbar-trailing">
          {toolbarTrailing}
          {onOpenInTab ? (
            <button
              type="button"
              className="wb-preview-btn wb-preview-external"
              aria-label={openInTabLabel}
              title={openInTabLabel}
              data-testid="wb-preview-open-tab"
              disabled={!openTabHref}
              onClick={() => {
                if (openTabHref) onOpenInTab(openTabHref);
              }}
            >
              ↗
            </button>
          ) : openTabHref ? (
            <a
              href={openTabHref}
              target="_blank"
              rel="noopener noreferrer"
              className="wb-preview-btn wb-preview-external"
              aria-label={openInTabLabel}
              title={openInTabLabel}
              data-testid="wb-preview-open-tab"
            >
              ↗
            </a>
          ) : null}
          {actions}
        </div>
      </div>

      {banner}

      {errorDisplay === "toggle" && showErrors && frameErrors.length > 0 ? (
        <ul className="wb-preview-error-list" data-testid="wb-preview-error-list">
          {frameErrors.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      ) : null}

      {errorDisplay === "banner" && frameError ? (
        <div className="wb-preview-banner-error" role="alert" data-testid="wb-preview-error">
          {frameError}
        </div>
      ) : null}

      <div className="wb-preview-stage" data-viewport-preset={viewportPreset}>
        {bootError ? (
          renderEmpty ? (
            renderEmpty({ booting: false, bootError })
          ) : (
            <div className="wb-preview-state" role="alert" data-testid="wb-preview-boot-error">
              <strong>Preview failed to start</strong>
              <p>{bootError}</p>
            </div>
          )
        ) : !adapterReady ? (
          renderEmpty ? (
            renderEmpty({ booting: true, bootError: null })
          ) : (
            <div className="wb-preview-state" role="status" data-testid="wb-preview-booting">
              <span>Starting preview…</span>
            </div>
          )
        ) : activePort === undefined ? (
          renderEmpty ? (
            renderEmpty({ booting: false, bootError: null })
          ) : (
            <div className="wb-preview-state" data-testid="wb-preview-empty">
              <strong>{emptyTitle}</strong>
              <p>{emptyDescription}</p>
            </div>
          )
        ) : (
          <div className="wb-preview-frame-wrap" data-viewport-preset={viewportPreset}>
            <iframe
              ref={frameRef}
              title={frameTitle || `Preview :${activePort}`}
              className="wb-preview-iframe"
              data-testid="wb-preview-iframe"
              sandbox={sandbox ?? undefined}
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
