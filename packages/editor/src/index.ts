export { EditorTabBar, type EditorTabBarProps } from "./editor-tab-bar";
export { EditorView, type EditorViewProps } from "./editor-view";
export { EditorWorkbench, type EditorWorkbenchProps } from "./editor-workbench";
export { languageIdForPath } from "./utils/language";
export {
  DEFAULT_MAX_ANALYSIS_BYTES,
  DEFAULT_MAX_MINIMAP_BYTES,
  documentAnalysisAllowed,
  documentFeatureTier,
  MI_CODE_UNITS,
  type DocumentFeatureTierResult,
} from "./utils/large-file";
export { createWorkbenchEditorPlugins, type WorkbenchEditorPluginOptions } from "./utils/plugins";
export { capOverscrollTop, scrollPositionFromSnapshot } from "./utils/scroll";
export { buildWorkbenchEditorTheme } from "./utils/theme";
