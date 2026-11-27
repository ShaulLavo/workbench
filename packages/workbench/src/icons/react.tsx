import { useId, useState } from "react";
import { FILE_ICON_GLYPHS } from "./generated/glyphs";
import { fileIconSymbolHref, resolveFileIcon, type FileIconEntry, type ResolvedFileIcon } from "./resolver";
import { useEnsureFileIconSprite } from "./sprite-manager";
import { STROKE_ICON_GLYPHS, type StrokeIconName } from "./stroke-glyphs";

/**
 * Ensures one reference-counted `<svg data-wb-icon-sprite>` exists in the owning `Document`
 * (including inside iframe portals) to back `<FileTypeIcon sprite />` without duplicate `<symbol>` IDs.
 * SSR- and hydration-safe: renders a zero-size hidden anchor without touching `document` during render.
 */
export function FileIconSprite() {
  const [sentinel, setSentinel] = useState<HTMLSpanElement | null>(null);
  useEnsureFileIconSprite(sentinel?.ownerDocument ?? null, true);
  return <span hidden ref={setSentinel} />;
}

export interface StrokeIconProps {
  readonly name: StrokeIconName;
  readonly className?: string;
}

/** Renders a lightweight 24x24 single-stroke UI chrome icon (chevrons, search, close, pane tabs). */
export function StrokeIcon({ name, className }: StrokeIconProps) {
  const glyph = STROKE_ICON_GLYPHS[name];
  const merged = className ? `wb-stroke-icon ${className}` : "wb-stroke-icon";
  return (
    <svg
      aria-hidden="true"
      className={merged}
      data-wb-stroke-icon={name}
      focusable="false"
      viewBox="0 0 24 24"
    >
      {glyph.paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export interface FileTypeIconProps {
  readonly icon?: ResolvedFileIcon;
  readonly entry?: FileIconEntry;
  readonly open?: boolean;
  readonly sprite?: boolean;
  readonly className?: string;
}

/**
 * Renders a file or folder icon from the canonical multi-hue MIT/CC0 icon set.
 * Accepts either a pre-resolved `icon` (best for virtualized rows) or an `entry`.
 */
export function FileTypeIcon({ icon, entry, open = false, sprite = false, className }: FileTypeIconProps) {
  const instanceId = useId();
  const resolved = icon ?? resolveFileIcon(entry ?? { name: "", type: "file" }, { open });
  const { rule } = resolved;
  const glyph = FILE_ICON_GLYPHS[rule.glyph];
  const merged = className ? `wb-icon ${className}` : "wb-icon";

  if (sprite) {
    return (
      <svg
        aria-hidden="true"
        className={merged}
        data-wb-icon={rule.glyph}
        data-wb-icon-hue={rule.hue}
        data-wb-icon-back={rule.backHue}
        focusable="false"
        viewBox={glyph.viewBox}
      >
        <use href={fileIconSymbolHref(rule.glyph)} />
      </svg>
    );
  }

  const scopedMarkup = glyph.paths.replaceAll("wb-icon-", `${instanceId}-`);
  return (
    <svg
      aria-hidden="true"
      className={merged}
      data-wb-icon={rule.glyph}
      data-wb-icon-hue={rule.hue}
      data-wb-icon-back={rule.backHue}
      focusable="false"
      viewBox={glyph.viewBox}
      dangerouslySetInnerHTML={{ __html: scopedMarkup }}
    />
  );
}
