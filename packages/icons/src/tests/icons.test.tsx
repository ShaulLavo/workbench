import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { validateSafeSvgGlyph } from "../../scripts/icon-generator";
import {
  buildFileIconSpriteMarkup,
  EXCLUDED_VSCODE_ICON_SOURCES,
  FILE_ICON_GLYPHS,
  FILE_ICON_MANIFEST,
  resolveFileIcon,
  resolveFileIconName,
} from "../index";
import { FileIconSprite, FileTypeIcon, StrokeIcon } from "../react/index";

describe("@shaulavo/workbench-icons", () => {
  it("resolves CLAUDE.md to the CC0 simple-icons claude glyph and never Pierre's claude.svg", () => {
    const resolved = resolveFileIcon({ name: "CLAUDE.md", type: "file" });
    expect(resolved.name).toBe("claude");
    expect(resolved.rule.glyph).toBe("claude");
    expect(FILE_ICON_MANIFEST.claude).toEqual({
      source: "simple-icons",
      sourceName: "siClaude",
      license: "CC0-1.0",
    });
    expect(EXCLUDED_VSCODE_ICON_SOURCES).toContain("claude");
    for (const spec of Object.values(FILE_ICON_MANIFEST)) {
      if (spec.source === "vscode-icons") {
        expect(EXCLUDED_VSCODE_ICON_SOURCES).not.toContain(spec.sourceName);
      }
    }
    expect(FILE_ICON_GLYPHS.claude.viewBox).toBe("0 0 24 24");
    expect(FILE_ICON_GLYPHS.claude.paths).toContain("<path");
  });

  it("matches multi-dot extensions and exact filenames before fallback extensions", () => {
    expect(resolveFileIconName("src/App.test.tsx")).toBe("typescript-test");
    expect(resolveFileIconName("src/App.spec.ts")).toBe("typescript-test");
    expect(resolveFileIconName("types/global.d.ts")).toBe("lang-typescript");
    expect(resolveFileIconName("vite.config.ts")).toBe("vite");
    expect(resolveFileIconName("custom.config.ts")).toBe("gear");
    expect(resolveFileIconName("package.json")).toBe("npm");
    expect(resolveFileIconName("bun.lock")).toBe("bun-duo");
    expect(resolveFileIconName("unknown.xyz")).toBe("file-duo");
  });

  it("returns frozen, referentially stable descriptors for directories, symlinks, and files", () => {
    const first = resolveFileIcon({ name: "src/index.ts", type: "file" });
    const second = resolveFileIcon({ name: "other.ts", type: "file" });
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);

    expect(resolveFileIcon({ name: "src", type: "directory" }).name).toBe("folder-duo");
    expect(resolveFileIcon({ name: "src", type: "directory" }, { open: true }).name).toBe("folder-open-duo");
    expect(resolveFileIcon({ name: "link", type: "symlink" }).name).toBe("file-symlink-duo");
  });

  it("builds complete rich and stroke sprite markup and renders React components cleanly", () => {
    const richSprite = buildFileIconSpriteMarkup("rich");
    expect(richSprite).toContain('id="wb-file-icon-claude"');
    expect(richSprite).toContain('id="wb-file-icon-typescript"');

    const strokeSprite = buildFileIconSpriteMarkup("stroke");
    expect(strokeSprite).toContain('id="wb-stroke-icon-claude"');
    expect(strokeSprite).toContain('id="wb-stroke-icon-test"');

    const spriteHtml = renderToStaticMarkup(<FileIconSprite preset="rich" />);
    expect(spriteHtml).toContain('data-wb-icon-sprite="rich"');

    const inlineHtml = renderToStaticMarkup(<FileTypeIcon entry={{ name: "CLAUDE.md", type: "file" }} />);
    expect(inlineHtml).toContain('data-wb-icon="claude"');
    expect(inlineHtml).toContain('data-wb-icon-hue="orange"');

    const useHtml = renderToStaticMarkup(
      <FileTypeIcon entry={{ name: "App.test.tsx", type: "file" }} sprite />,
    );
    expect(useHtml).toContain('href="#wb-file-icon-lang-typescript-duo"');

    const strokeHtml = renderToStaticMarkup(
      <FileTypeIcon entry={{ name: "App.test.tsx", type: "file" }} preset="stroke" />,
    );
    expect(strokeHtml).toContain('data-wb-stroke-icon="test"');

    const uiStroke = renderToStaticMarkup(<StrokeIcon name="search" />);
    expect(uiStroke).toContain('data-wb-stroke-icon="search"');
  });

  it("rejects unsafe SVG elements, event handlers, and external references", () => {
    expect(() => validateSafeSvgGlyph("test", { viewBox: "0 0 16 16", paths: "<foreignObject/>" })).toThrow(
      /Disallowed SVG element/,
    );
    expect(() =>
      validateSafeSvgGlyph("test", { viewBox: "0 0 16 16", paths: "<script>alert(1)</script>" }),
    ).toThrow(/Unexpected text node|Disallowed SVG element/);
    expect(() =>
      validateSafeSvgGlyph("test", {
        viewBox: "0 0 16 16",
        paths: '<path d="M0 0" onclick="alert(1)"/>',
      }),
    ).toThrow(/Disallowed SVG attribute/);
    expect(() =>
      validateSafeSvgGlyph("test", {
        viewBox: "0 0 16 16",
        paths: '<use href="https://example.com/evil.svg#a"/>',
      }),
    ).toThrow(/Unsafe SVG href/);
    expect(() =>
      validateSafeSvgGlyph("test", {
        viewBox: "0 0 16 16",
        paths: '<path fill="url(#other-id)" d="M0 0"/>',
      }),
    ).toThrow(/Unsafe SVG url\(\) reference/);
  });
});
