import type { Subscribable } from "../subscribable";

export interface PreviewServerInfo {
  readonly port: number;
  readonly label?: string;
  readonly url?: string;
}

export interface PreviewLocation {
  readonly port: number;
  readonly path: string;
}

export type PreviewFrameEvent =
  | { readonly type: "bridge-ready"; readonly supported: boolean }
  | { readonly type: "started"; readonly location: PreviewLocation }
  | { readonly type: "navigate"; readonly location: PreviewLocation }
  | { readonly type: "title"; readonly title: string }
  | { readonly type: "console"; readonly level: "log" | "warn" | "error"; readonly text: string }
  | { readonly type: "error"; readonly message: string };

export interface PreviewFrameController {
  /** Called on every iframe load event so bridged transports run their per-document hello handshake. */
  onFrameLoad(): void;
  /** Steers via the frame bridge when supported, or falls back to `frame.src` when bridge-less. */
  navigate(path: string): void;
  reload(): void;
  back(): void;
  forward(): void;
  dispose(): void;
}

export interface PreviewAdapter {
  readonly kind: "none" | "mounted" | "isolated" | "remote";
  readonly servers: Subscribable<readonly PreviewServerInfo[]>;
  whenReady(): Promise<void>;
  frameUrl(port: number, path: string): string;
  tabUrl(port: number, path: string): string;
  locate(href: string): PreviewLocation | undefined;
  /**
   * Binds an iframe to a server port. Implementations validate `event.source === frame.contentWindow`
   * and expected origin before forwarding events, and encapsulate any postMessage handshake.
   */
  attachFrame(
    frame: HTMLIFrameElement,
    port: number,
    onEvent: (event: PreviewFrameEvent) => void,
    options?: { readonly initialPath?: string },
  ): PreviewFrameController;
  onReloadNeeded?(listener: () => void): () => void;
}
