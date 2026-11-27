import {
  createBracketMatchPlugin,
  createDocumentLinkPlugin,
  createMergeConflictPlugin,
  createOccurrenceHighlightPlugin,
} from "@singapore-editor/core/editor";
import type { EditorPlugin } from "@singapore-editor/core/extensions";
import type { EditorSyntaxLanguageId } from "@singapore-editor/core/syntax";
import { createEditorFindPlugin } from "@singapore-editor/find";
import { createFoldGutterPlugin } from "@singapore-editor/gutters/fold-gutter";
import { createLineGutterPlugin } from "@singapore-editor/gutters/line-gutter";
import {
  createHighlightingPlugin,
  type HighlightingService,
  type HighlightingThemeSource,
} from "@singapore-editor/highlighting";
import { createTouchSelectionPlugin } from "@singapore-editor/plugin-ui/touch-selection-plugin";

export interface WorkbenchEditorPluginOptions {
  readonly languageId?: EditorSyntaxLanguageId | null;
  readonly analysisAllowed?: boolean;
  /** Collapses the fold gutter to 0px on narrow/phone viewports while preserving line numbers. */
  readonly narrowViewport?: boolean;
  readonly highlightingService?: HighlightingService | null;
  readonly highlightingTheme?: HighlightingThemeSource;
  readonly compareMergeConflict?: () => void;
  readonly extraPlugins?: readonly EditorPlugin[];
}

/**
 * Builds the baseline Singapore plugin stack shared across Sprockt, Fregat, and Consumer 3.
 * Always mounts `createTouchSelectionPlugin()` and line gutter; collapses fold gutter on narrow
 * viewports; disables syntax/bracket/occurrence/merge-conflict analysis above large-file thresholds.
 */
export function createWorkbenchEditorPlugins(
  options: WorkbenchEditorPluginOptions = {},
): readonly EditorPlugin[] {
  const analysisAllowed = options.analysisAllowed ?? true;
  const narrow = options.narrowViewport ?? false;

  const syntaxPlugins: readonly EditorPlugin[] =
    analysisAllowed && options.highlightingService
      ? [
          createHighlightingPlugin({
            name: "workbench.syntax",
            service: options.highlightingService,
            theme: options.highlightingTheme,
          }),
        ]
      : [];

  const corePlugins: readonly EditorPlugin[] = [
    createLineGutterPlugin(),
    createTouchSelectionPlugin(),
    createEditorFindPlugin(),
  ];

  const analysisPlugins: readonly EditorPlugin[] = analysisAllowed
    ? [
        createFoldGutterPlugin({ width: narrow ? 0 : 16 }),
        createMergeConflictPlugin({ compare: options.compareMergeConflict }),
        createBracketMatchPlugin({
          style: { backgroundColor: "var(--wb-row-selected)" },
        }),
        createOccurrenceHighlightPlugin({
          style: { backgroundColor: "var(--wb-row-hover)" },
        }),
        createDocumentLinkPlugin(),
      ]
    : [];

  return syntaxPlugins.concat(corePlugins, analysisPlugins, options.extraPlugins ?? []);
}
