import type { ActivationFocusDecision, LspHostAdapter } from "@shaulavo/workbench-core";
import type { LspManagedTransport } from "@singapore-editor/lsp";
import {
  createLanguageServerAdapterPlugin,
  type LanguageServerAdapterPluginOptions,
  type LanguageServerPlugin,
} from "@singapore-editor/lsp-plugin";

/**
 * Typed Singapore LSP adapter extending `@shaulavo/workbench-core`'s backend-neutral
 * `LspHostAdapter` with Singapore's `LspManagedTransport` factory.
 */
export interface SingaporeLspAdapter extends LspHostAdapter {
  createTransport(languageId: string, rootUri: string): LspManagedTransport | null;
}

export interface WorkbenchLspPluginOptions {
  readonly adapter: SingaporeLspAdapter;
  readonly languageId: string;
  readonly rootUri: string;
  readonly name?: string;
  readonly onDiagnostics?: LanguageServerAdapterPluginOptions["onDiagnostics"];
  readonly onDidNavigateDiagnostic?: LanguageServerAdapterPluginOptions["onDidNavigateDiagnostic"];
  readonly onStatusChange?: LanguageServerAdapterPluginOptions["onStatusChange"];
}

/**
 * Bridges a `SingaporeLspAdapter` onto `@singapore-editor/lsp-plugin`'s adapter plugin,
 * forwarding definition navigation through `adapter.openLocation` with explicit focus policy.
 */
export function createWorkbenchLspPlugin(options: WorkbenchLspPluginOptions): LanguageServerPlugin {
  const { adapter, languageId, rootUri } = options;
  return createLanguageServerAdapterPlugin({
    name: options.name ?? `workbench.lsp.${languageId}`,
    rootUri,
    createTransport: () => {
      const transport = adapter.createTransport(languageId, rootUri);
      if (!transport) {
        throw new Error(`No LSP transport available for ${languageId}`);
      }
      return transport;
    },
    onConnected: () => {
      adapter.onConnected?.(languageId);
    },
    onStatusChange: options.onStatusChange,
    onDiagnostics: options.onDiagnostics,
    onDidNavigateDiagnostic: options.onDidNavigateDiagnostic,
    onOpenDefinition: (target) => {
      const targetPath = adapter.uriToPath(target.uri);
      if (!targetPath) return false;
      const focus: ActivationFocusDecision = {
        shouldFocusEditor: true,
        origin: "keyboard",
      };
      return adapter.openLocation(
        {
          path: targetPath,
          line: target.range.start.line + 1,
          column: target.range.start.character + 1,
        },
        focus,
      );
    },
  });
}
