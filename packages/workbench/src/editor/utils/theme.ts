import { resolveColorScheme } from "../../tokens/index";
import type { EditorTheme } from "@singapore-editor/core/rendering";

function readVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Projects `--wb-*` and `--wb-syn-*` CSS custom properties from `host` onto a Singapore
 * `EditorTheme` so plain-CSS (Sprockt) and Tailwind v4 (Fregat) hosts style Singapore identically.
 * Preserves CSS color syntax (`oklch()`, `light-dark()`, `color-mix()`, alpha) intact for DOM rendering.
 */
export function buildWorkbenchEditorTheme(host: Element | null): EditorTheme {
  const scheme = host ? resolveColorScheme(host) : "light";
  if (!host || typeof getComputedStyle !== "function") {
    return {
      type: scheme,
      backgroundColor: "var(--wb-bg-well)",
      foregroundColor: "var(--wb-fg)",
      gutterBackgroundColor: "var(--wb-bg-well)",
      gutterForegroundColor: "var(--wb-fg-subtle)",
      selectionColor: "var(--wb-row-selected)",
      inactiveSelectionColor: "var(--wb-row-hover)",
      popupBackgroundColor: "var(--wb-bg-elevated)",
      caretColor: "var(--wb-accent)",
      colors: {
        "lsp.diagnostic.error": "var(--wb-fg)",
        "lsp.diagnostic.errorBackground": "transparent",
        "lsp.diagnostic.errorUnderline": "var(--wb-danger)",
        "lsp.diagnostic.warningBackground": "color-mix(in oklab, var(--wb-warn) 20%, transparent)",
        "lsp.diagnostic.informationBackground": "color-mix(in oklab, var(--wb-accent) 16%, transparent)",
      },
      syntax: {
        comment: "var(--wb-syn-comment)",
        keyword: "var(--wb-syn-keyword)",
        keywordDeclaration: "var(--wb-syn-keyword)",
        keywordImport: "var(--wb-syn-keyword)",
        string: "var(--wb-syn-string)",
        number: "var(--wb-syn-number)",
        function: "var(--wb-syn-function)",
        type: "var(--wb-syn-type)",
        typeDefinition: "var(--wb-syn-type)",
        typeParameter: "var(--wb-syn-type)",
        variable: "var(--wb-syn-variable)",
        variableBuiltin: "var(--wb-syn-keyword)",
        property: "var(--wb-syn-property)",
        constant: "var(--wb-syn-number)",
        attribute: "var(--wb-syn-attr)",
        bracket: "var(--wb-fg-muted)",
      },
    };
  }

  const style = getComputedStyle(host);
  const bg = readVar(style, "--wb-bg-well", scheme === "dark" ? "#0a0d14" : "#ffffff");
  const fg = readVar(style, "--wb-fg", scheme === "dark" ? "#e9edf3" : "#111111");
  const gutterFg = readVar(style, "--wb-fg-subtle", scheme === "dark" ? "#8893a6" : "#5c616b");
  const selection = readVar(style, "--wb-row-selected", scheme === "dark" ? "#1f3b5c" : "#cfe0ff");
  const inactiveSel = readVar(style, "--wb-row-hover", scheme === "dark" ? "#1c2333" : "#f1f3f7");
  const popup = readVar(style, "--wb-bg-elevated", scheme === "dark" ? "#161b26" : "#ffffff");
  const caret = readVar(style, "--wb-accent", scheme === "dark" ? "#5ab9fc" : "#1a4be0");

  const comment = readVar(style, "--wb-syn-comment", gutterFg);
  const keyword = readVar(style, "--wb-syn-keyword", caret);
  const str = readVar(style, "--wb-syn-string", scheme === "dark" ? "#86efac" : "#15803d");
  const num = readVar(style, "--wb-syn-number", scheme === "dark" ? "#fcd34d" : "#b45309");
  const fn = readVar(style, "--wb-syn-function", scheme === "dark" ? "#93c5fd" : "#1d4ed8");
  const type = readVar(style, "--wb-syn-type", scheme === "dark" ? "#c4b5fd" : "#6d28d9");
  const variable = readVar(style, "--wb-syn-variable", fg);
  const prop = readVar(style, "--wb-syn-property", fg);
  const attr = readVar(style, "--wb-syn-attr", fn);

  const danger = readVar(style, "--wb-danger", scheme === "dark" ? "#f87171" : "#c81e2b");
  const warning = readVar(style, "--wb-warn", scheme === "dark" ? "#f2c779" : "#9a5b00");

  return {
    type: scheme,
    backgroundColor: bg,
    foregroundColor: fg,
    gutterBackgroundColor: bg,
    gutterForegroundColor: gutterFg,
    selectionColor: selection,
    inactiveSelectionColor: inactiveSel,
    popupBackgroundColor: popup,
    caretColor: caret,
    colors: {
      "lsp.diagnostic.error": fg,
      "lsp.diagnostic.errorBackground": "transparent",
      "lsp.diagnostic.errorUnderline": danger,
      "lsp.diagnostic.warningBackground": `color-mix(in oklab, ${warning} 20%, transparent)`,
      "lsp.diagnostic.informationBackground": `color-mix(in oklab, ${caret} 16%, transparent)`,
    },
    syntax: {
      comment,
      keyword,
      keywordDeclaration: keyword,
      keywordImport: keyword,
      string: str,
      number: num,
      function: fn,
      type,
      typeDefinition: type,
      typeParameter: type,
      variable,
      variableBuiltin: keyword,
      property: prop,
      constant: num,
      attribute: attr,
      bracket: gutterFg,
    },
  };
}
