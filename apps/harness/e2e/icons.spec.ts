import { expect, test } from "@playwright/test";
import { FILE_ICON_GLYPHS } from "@shaulavo/workbench/icons/core";

interface InvisibleShapeFinding {
  readonly name: string;
  readonly shapeIndex: number;
  readonly markup: string;
}

interface HtmlCutoutSample {
  readonly mode: "light" | "dark";
  readonly shieldTopAlpha: number;
  readonly shieldBetweenBarsAlpha: number;
  readonly fiveTopBarAlpha: number;
  readonly fiveMidBarAlpha: number;
  readonly fiveBottomBarAlpha: number;
  readonly shieldRgb: readonly [number, number, number];
}

async function sampleHtmlCutoutInPage(args: {
  readonly viewBox: string;
  readonly paths: string;
}): Promise<HtmlCutoutSample[]> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");

  const probe = document.createElement("span");
  probe.setAttribute("data-wb-icon-hue", "orange");
  document.body.appendChild(probe);

  const prevTheme = document.documentElement.getAttribute("data-theme");
  const prevDark = document.documentElement.classList.contains("dark");

  async function sampleMode(mode: "light" | "dark"): Promise<HtmlCutoutSample> {
    document.documentElement.setAttribute("data-theme", mode);
    document.documentElement.classList.toggle("dark", mode === "dark");
    const color = getComputedStyle(probe).color;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="${args.viewBox}" style="color:${color}">${args.paths}</svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      ctx!.clearRect(0, 0, 64, 64);
      ctx!.drawImage(img, 0, 0, 64, 64);
    } finally {
      URL.revokeObjectURL(url);
    }

    const data = ctx!.getImageData(0, 0, 64, 64).data;
    const sampleAt = (vx: number, vy: number): [number, number, number, number] => {
      const idx = (Math.round(vy * 2) * 64 + Math.round(vx * 2)) * 4;
      return [data[idx] ?? 0, data[idx + 1] ?? 0, data[idx + 2] ?? 0, data[idx + 3] ?? 0];
    };

    const topShield = sampleAt(16, 3);
    const betweenBars = sampleAt(16, 11.5);
    const topBar = sampleAt(16, 7.75);
    const midBar = sampleAt(16, 15);
    const bottomBar = sampleAt(16, 24);

    return {
      mode,
      shieldTopAlpha: topShield[3],
      shieldBetweenBarsAlpha: betweenBars[3],
      fiveTopBarAlpha: topBar[3],
      fiveMidBarAlpha: midBar[3],
      fiveBottomBarAlpha: bottomBar[3],
      shieldRgb: [topShield[0], topShield[1], topShield[2]],
    };
  }

  try {
    return [await sampleMode("light"), await sampleMode("dark")];
  } finally {
    probe.remove();
    if (prevTheme === null) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", prevTheme);
    document.documentElement.classList.toggle("dark", prevDark);
  }
}

async function auditMultiShapeGlyphsInPage(
  glyphList: readonly { readonly name: string; readonly viewBox: string; readonly paths: string }[],
): Promise<InvisibleShapeFinding[]> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");

  const shapeSelector = "path, circle, rect, ellipse, polygon, polyline, line";
  const parser = new DOMParser();

  async function rasterize(viewBox: string, markup: string): Promise<Uint8ClampedArray> {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="${viewBox}" style="color:#d5512f;--wb-icon-neutral:#6c6c71;--wb-icon-back:#1a85d4;">${markup}</svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      ctx!.clearRect(0, 0, 64, 64);
      ctx!.drawImage(img, 0, 0, 64, 64);
      return new Uint8ClampedArray(ctx!.getImageData(0, 0, 64, 64).data);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function countChangedPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      const dr = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
      const dg = Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0));
      const db = Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0));
      const da = Math.abs((a[i + 3] ?? 0) - (b[i + 3] ?? 0));
      if (dr > 2 || dg > 2 || db > 2 || da > 2) changed += 1;
    }
    return changed;
  }

  async function auditEntry(entry: {
    readonly name: string;
    readonly viewBox: string;
    readonly paths: string;
  }): Promise<InvisibleShapeFinding[]> {
    const doc = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${entry.viewBox}">${entry.paths}</svg>`,
      "image/svg+xml",
    );
    const root = doc.documentElement;
    const shapes = Array.from(root.querySelectorAll(shapeSelector));
    if (shapes.length <= 1) return [];

    const baseline = await rasterize(entry.viewBox, entry.paths);
    const found: InvisibleShapeFinding[] = [];
    for (let i = 0; i < shapes.length; i += 1) {
      const clone = root.cloneNode(true) as Element;
      const target = clone.querySelectorAll(shapeSelector)[i];
      if (!target) continue;
      target.remove();
      const withoutShape = await rasterize(entry.viewBox, clone.innerHTML);
      if (countChangedPixels(baseline, withoutShape) === 0) {
        found.push({ name: entry.name, shapeIndex: i, markup: target.outerHTML.slice(0, 120) });
      }
    }
    return found;
  }

  const findings: InvisibleShapeFinding[] = [];
  for (const entry of glyphList) {
    const entryFindings = await auditEntry(entry);
    for (const item of entryFindings) findings.push(item);
  }
  return findings;
}

test("html icon renders a visible 5 cutout in both light and dark modes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("harness-ready")).toBeVisible();

  const htmlGlyph = FILE_ICON_GLYPHS.html;
  const samples = await page.evaluate(sampleHtmlCutoutInPage, {
    viewBox: htmlGlyph.viewBox,
    paths: htmlGlyph.paths,
  });

  expect(samples).toHaveLength(2);
  for (const sample of samples) {
    // Outer shield and inner gap between the 5's horizontal bars must be painted opaque orange.
    expect(sample.shieldTopAlpha).toBeGreaterThan(220);
    expect(sample.shieldBetweenBarsAlpha).toBeGreaterThan(220);
    // All three strokes of the "5" must punch through transparently so light/dark backgrounds show through.
    expect(sample.fiveTopBarAlpha).toBe(0);
    expect(sample.fiveMidBarAlpha).toBe(0);
    expect(sample.fiveBottomBarAlpha).toBe(0);
    // Orange hue has red channel strictly higher than blue channel in both light and dark themes.
    expect(sample.shieldRgb[0]).toBeGreaterThan(sample.shieldRgb[2]);
  }
  // Light and dark themes resolve distinct orange tones via light-dark().
  expect(samples[0]?.shieldRgb).not.toEqual(samples[1]?.shieldRgb);
});

test("every shape in all multi-shape file icon glyphs contributes visible pixels", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("harness-ready")).toBeVisible();

  const entries = Object.entries(FILE_ICON_GLYPHS).map(([name, glyph]) => ({
    name,
    viewBox: glyph.viewBox,
    paths: glyph.paths,
  }));
  const invisible = await page.evaluate(auditMultiShapeGlyphsInPage, entries);
  expect(invisible).toEqual([]);
});
