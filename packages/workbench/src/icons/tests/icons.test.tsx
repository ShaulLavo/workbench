import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  combineEvenOddCutoutPaths,
  normalizeLeadingMoveToAbsolute,
  validateSafeSvgGlyph,
} from "../../../scripts/icon-generator";
import {
  buildFileIconSpriteMarkup,
  EXCLUDED_VSCODE_ICON_SOURCES,
  FILE_ICON_GLYPHS,
  FILE_ICON_MANIFEST,
  resolveFileIcon,
  resolveFileIconName,
  STROKE_ICON_GLYPHS,
} from "../core";
import { FileIconSprite, FileTypeIcon, StrokeIcon } from "../react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: { readonly root: Root; readonly host: HTMLElement }[] = [];

function mountNode(element: React.ReactElement, targetDoc: Document = document): HTMLElement {
  const host = targetDoc.createElement("div");
  targetDoc.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  mountedRoots.push({ root, host });
  return host;
}

afterEach(() => {
  while (mountedRoots.length > 0) {
    const entry = mountedRoots.pop()!;
    act(() => {
      entry.root.unmount();
    });
    entry.host.remove();
  }
});

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

  it("normalizes the html icon as a single evenodd cutout path so the inner 5 stays visible", () => {
    const resolved = resolveFileIcon({ name: "index.html", type: "file" });
    expect(resolved.name).toBe("html");
    expect(resolved.rule.glyph).toBe("html");
    expect(resolved.rule.hue).toBe("orange");

    const htmlGlyph = FILE_ICON_GLYPHS.html;
    const pathMatches = htmlGlyph.paths.match(/<path\b[^>]*>/g) ?? [];
    expect(pathMatches).toHaveLength(1);
    expect(htmlGlyph.paths).toContain('fill-rule="evenodd"');
    expect(htmlGlyph.paths).toContain('clip-rule="evenodd"');
    expect(htmlGlyph.paths).toContain("ZM25 6l-.32 3.5");
  });

  it("converts leading relative movetos and merges opaque cutout paths safely", () => {
    expect(normalizeLeadingMoveToAbsolute("m25 6-.32 3.5H10z")).toBe("M25 6l-.32 3.5H10z");
    expect(normalizeLeadingMoveToAbsolute("m10 20L30 40")).toBe("M10 20L30 40");
    expect(normalizeLeadingMoveToAbsolute("M1 2 3 4")).toBe("M1 2 3 4");

    const merged = combineEvenOddCutoutPaths(
      "demo",
      '<path fill="currentColor" d="M0 0h10v10H0"/> <path fill="currentColor" d="m2 2 6 0v6H2z"/>',
    );
    expect(merged).toBe(
      '<path fill="currentColor" fill-rule="evenodd" d="M0 0h10v10H0ZM2 2l6 0v6H2z" clip-rule="evenodd"/>',
    );

    expect(() => combineEvenOddCutoutPaths("demo", '<path fill="currentColor" d="M0 0h10v10H0z"/>')).toThrow(
      /expected >=2 plain currentColor/,
    );
    expect(() =>
      combineEvenOddCutoutPaths(
        "demo",
        '<path fill="currentColor" d="M0 0h10v10H0z" opacity=".5"/> <path fill="currentColor" d="M2 2h6v6H2z"/>',
      ),
    ).toThrow(/non-plain element/);
  });

  it("prevents unreviewed glyphs with multiple plain opaque currentColor paths from flattening inner details", () => {
    // Only genuinely disjoint multi-path monochrome glyphs may ship >1 plain opaque currentColor <path>.
    // Overlapping shield/badge cutouts (like html) must be merged with fill-rule="evenodd".
    const allowedDisjointMultiPathGlyphs = new Set([
      "browserslist-duo",
      "mcp",
      "nextjs",
      "server-duo",
      "stylelint",
      "zig",
    ]);
    const plainOpaquePathRe =
      /^<path\s+(?:fill="currentColor"\s+d="[^"]+"|d="[^"]+"\s+fill="currentColor")\s*\/>$/;

    const unexpected: string[] = [];
    for (const [name, glyph] of Object.entries(FILE_ICON_GLYPHS)) {
      const elements = glyph.paths.match(/<[^>]+>/g) ?? [];
      const plainOpaquePaths = elements.filter((el) => plainOpaquePathRe.test(el));
      if (plainOpaquePaths.length >= 2 && !allowedDisjointMultiPathGlyphs.has(name)) {
        unexpected.push(name);
      }
    }
    expect(unexpected).toEqual([]);
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

  it("builds canonical file icon sprite markup and renders file and chrome icon components cleanly", () => {
    const sprite = buildFileIconSpriteMarkup();
    expect(sprite).toContain('id="wb-file-icon-claude"');
    expect(sprite).toContain('id="wb-file-icon-typescript"');

    const spriteHtml = renderToStaticMarkup(<FileIconSprite />);
    expect(spriteHtml).toBe('<span hidden=""></span>');

    mountNode(<FileIconSprite />);
    const mountedSprites = document.body.querySelectorAll("svg[data-wb-icon-sprite]");
    expect(mountedSprites).toHaveLength(1);
    expect(mountedSprites[0]?.innerHTML).toContain('id="wb-file-icon-claude"');

    const inlineHtml = renderToStaticMarkup(<FileTypeIcon entry={{ name: "CLAUDE.md", type: "file" }} />);
    expect(inlineHtml).toContain('data-wb-icon="claude"');
    expect(inlineHtml).toContain('data-wb-icon-hue="orange"');

    const useHtml = renderToStaticMarkup(
      <FileTypeIcon entry={{ name: "App.test.tsx", type: "file" }} sprite />,
    );
    expect(useHtml).toContain('href="#wb-file-icon-lang-typescript-duo"');

    const uiStroke = renderToStaticMarkup(<StrokeIcon name="search" />);
    expect(uiStroke).toContain('data-wb-stroke-icon="search"');
    expect("react" in STROKE_ICON_GLYPHS).toBe(false);
    expect("typescript" in STROKE_ICON_GLYPHS).toBe(false);
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
        paths: '<use href="&#x68;ttps://example.com/evil.svg#a"/>',
      }),
    ).toThrow(/Disallowed SVG construct, entity, or URI scheme/);
    expect(() =>
      validateSafeSvgGlyph("test", {
        viewBox: "0 0 16 16",
        paths: '<path fill="url(#other-id)" d="M0 0"/>',
      }),
    ).toThrow(/Unsafe SVG url\(\) reference/);
  });

  it("ref-counts a single shared sprite per Document across sibling mounts and iframe portals", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);
    const rootA = createRoot(first);
    const rootB = createRoot(second);

    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeDoc = iframe.contentDocument!;
    const iframeHost = iframeDoc.createElement("div");
    iframeDoc.body.appendChild(iframeHost);
    const rootIframe = createRoot(iframeHost);

    try {
      act(() => {
        rootA.render(
          <>
            <FileIconSprite />
            <FileTypeIcon entry={{ name: "index.ts", type: "file" }} sprite />
          </>,
        );
        rootB.render(<FileIconSprite />);
      });

      const parentSprites = document.body.querySelectorAll("svg[data-wb-icon-sprite]");
      expect(parentSprites).toHaveLength(1);
      const symbolIds = Array.from(parentSprites[0]!.querySelectorAll("symbol")).map((s) => s.id);
      expect(new Set(symbolIds).size).toBe(symbolIds.length);

      // Portal into an iframe Document mounts its own single sprite via ownerDocument.
      act(() => {
        rootIframe.render(
          createPortal(
            <>
              <FileIconSprite />
              <FileTypeIcon entry={{ name: "CLAUDE.md", type: "file" }} sprite />
            </>,
            iframeHost,
          ),
        );
      });
      expect(document.body.querySelectorAll("svg[data-wb-icon-sprite]")).toHaveLength(1);
      expect(iframeDoc.body.querySelectorAll("svg[data-wb-icon-sprite]")).toHaveLength(1);
      expect(iframeDoc.getElementById("wb-file-icon-claude")).not.toBeNull();

      // Unmounting first mount keeps parent sprite alive for second mount.
      act(() => {
        rootA.unmount();
      });
      expect(document.body.querySelectorAll("svg[data-wb-icon-sprite]")).toHaveLength(1);
      expect(iframeDoc.body.querySelectorAll("svg[data-wb-icon-sprite]")).toHaveLength(1);

      // Unmounting iframe portal removes only iframe's sprite.
      act(() => {
        rootIframe.unmount();
      });
      expect(iframeDoc.body.querySelectorAll("svg[data-wb-icon-sprite]")).toHaveLength(0);
      expect(document.body.querySelectorAll("svg[data-wb-icon-sprite]")).toHaveLength(1);

      // Unmounting last parent mount removes parent sprite cleanly.
      act(() => {
        rootB.unmount();
      });
      expect(document.body.querySelectorAll("svg[data-wb-icon-sprite]")).toHaveLength(0);
    } finally {
      first.remove();
      second.remove();
      iframe.remove();
    }
  });
});
