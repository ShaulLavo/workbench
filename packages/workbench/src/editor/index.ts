import "../styles/tokens.css";
import "../styles/icons.css";
import "../styles/ui.css";
import "../styles/editor.css";

export {
  EditorSessionView,
  type EditorRevealTarget,
  type EditorSessionAttachment,
  type EditorSessionViewProps,
} from "./editor-session-view";
export { EditorTabBar, type EditorTabBarProps } from "./editor-tab-bar";
export { EditorView, type EditorViewProps } from "./editor-view";
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
