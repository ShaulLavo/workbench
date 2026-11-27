import { useId } from "react";
import { FILE_ICON_GLYPHS } from "../generated/glyphs";
import {
  buildFileIconSpriteMarkup,
  fileIconSymbolHref,
  resolveFileIcon,
  type FileIconEntry,
  type ResolvedFileIcon,
} from "../resolver";
import { STROKE_ICON_GLYPHS, type StrokeIconName } from "../stroke-glyphs";

/** Mount once per document to back `<FileTypeIcon sprite />` with zero per-row SVG path duplication. */
export function FileIconSprite() {
  const markup = buildFileIconSpriteMarkup();
  return (
    <svg
      aria-hidden="true"
      data-wb-icon-sprite=""
      focusable="false"
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
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
