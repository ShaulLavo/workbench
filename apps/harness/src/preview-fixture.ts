import type { PreviewAdapter, PreviewServerInfo, Subscribable } from "@shaulavo/workbench/core";
import {
  createBridgelessPreviewController,
  createPreviewBridgeController,
} from "@shaulavo/workbench/preview";

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

/** Bridged Sprockt-style preview adapter over loopback `/preview-bridged.html` with hello handshake. */
export function createBridgedHarnessPreviewAdapter(): PreviewAdapter {
  const servers = createSubscribable<readonly PreviewServerInfo[]>([
    { port: 5173, label: "vite" },
    { port: 3000, label: "api" },
  ]);

  const makeUrl = (port: number, path: string): string =>
    `/preview-bridged.html?port=${port}&path=${encodeURIComponent(path)}`;

  return {
    kind: "mounted",
    servers,
    whenReady: async () => {},
    frameUrl: makeUrl,
    tabUrl: makeUrl,
    locate(href) {
      try {
        const parsed = new URL(href, window.location.origin);
        const port = Number(parsed.searchParams.get("port") ?? "5173");
        const path = parsed.searchParams.get("path") ?? "/";
        return { port, path };
      } catch {
        return undefined;
      }
    },
    attachFrame(frame, port, onEvent, options) {
      return createPreviewBridgeController({
        frame,
        port,
        frameUrl: makeUrl,
        expectedOrigin: "null",
        initialPath: options?.initialPath,
        onEvent,
      });
    },
  };
}

/** Bridge-less Consumer-3-style remote preview adapter over loopback `/preview-remote.html`. */
export function createRemoteHarnessPreviewAdapter(): PreviewAdapter {
  const servers = createSubscribable<readonly PreviewServerInfo[]>([{ port: 4173, label: "sandbox" }]);

  const makeUrl = (port: number, path: string): string =>
    `/preview-remote.html?port=${port}&path=${encodeURIComponent(path)}`;

  return {
    kind: "remote",
    servers,
    whenReady: async () => {},
    frameUrl: makeUrl,
    tabUrl: makeUrl,
    locate(href) {
      try {
        const parsed = new URL(href, window.location.origin);
        const port = Number(parsed.searchParams.get("port") ?? "4173");
        const path = parsed.searchParams.get("path") ?? "/";
        return { port, path };
      } catch {
        return undefined;
      }
    },
    attachFrame(frame, port, onEvent, options) {
      return createBridgelessPreviewController({
        frame,
        port,
        frameUrl: makeUrl,
        initialPath: options?.initialPath,
        onEvent,
      });
    },
  };
}
