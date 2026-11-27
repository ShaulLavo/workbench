import "../styles/tokens.css";
import "../styles/icons.css";
import "../styles/ui.css";
import "../styles/editor.css";

export {
  CodeEditor,
  type CodeEditorAdapterProps,
  type CodeEditorCommonProps,
  type CodeEditorProps,
  type CodeEditorSessionProps,
  type EditorRevealTarget,
  type EditorSessionAttachment,
} from "./code-editor";
export { EditorTabBar, type EditorTabBarProps } from "./editor-tab-bar";
export { EditorWorkbench, type EditorWorkbenchProps } from "./editor-workbench";
export { languageIdForPath, languageLabelForPath } from "./utils/language";
export {
  DEFAULT_MAX_ANALYSIS_BYTES,
  DEFAULT_MAX_MINIMAP_BYTES,
  documentAnalysisAllowed,
  documentFeatureTier,
  MI_CODE_UNITS,
  type DocumentFeatureTierResult,
} from "./utils/large-file";
export { createWorkbenchEditorPlugins, type WorkbenchEditorPluginOptions } from "./utils/plugins";
export { clampRestoredScroll, capOverscrollTop, scrollPositionFromSnapshot } from "./utils/scroll";
export { buildWorkbenchEditorTheme } from "./utils/theme";
