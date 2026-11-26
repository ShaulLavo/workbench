import { useId } from "react";
import { FILE_ICON_GLYPHS } from "../generated/glyphs";
import {
  buildFileIconSpriteMarkup,
  fileIconSymbolHref,
  resolveFileIcon,
  strokeIconSymbolHref,
  type FileIconEntry,
  type FileIconPreset,
  type ResolvedFileIcon,
} from "../resolver";
import { STROKE_ICON_GLYPHS, type StrokeIconName } from "../stroke-glyphs";

export interface FileIconSpriteProps {
  readonly preset?: FileIconPreset;
}

/** Mount once per document to back `<FileTypeIcon sprite />` with zero per-row SVG path duplication. */
export function FileIconSprite({ preset = "rich" }: FileIconSpriteProps) {
  const markup = buildFileIconSpriteMarkup(preset);
  return (
    <svg
      aria-hidden="true"
      data-wb-icon-sprite={preset}
      focusable="false"
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

export interface StrokeIconProps {
  readonly name: StrokeIconName;
  readonly className?: string;
  readonly sprite?: boolean;
}

/** Renders a minimal 24x24 single-stroke icon from the MIT Sprockt preset. */
export function StrokeIcon({ name, className, sprite = false }: StrokeIconProps) {
  const glyph = STROKE_ICON_GLYPHS[name];
  const merged = className ? `wb-stroke-icon ${className}` : "wb-stroke-icon";
  if (sprite) {
    return (
      <svg
        aria-hidden="true"
        className={merged}
        data-wb-stroke-icon={name}
        focusable="false"
        viewBox="0 0 24 24"
      >
        <use href={strokeIconSymbolHref(name)} />
      </svg>
    );
  }
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
      {"label" in glyph && glyph.label ? (
        <text
          x="12"
          y="15.6"
          textAnchor="middle"
          fontSize="8.6"
          fontWeight="700"
          fill="currentColor"
          stroke="none"
        >
          {glyph.label}
        </text>
      ) : null}
    </svg>
  );
}

export interface FileTypeIconProps {
  readonly icon?: ResolvedFileIcon;
  readonly entry?: FileIconEntry;
  readonly open?: boolean;
  readonly preset?: FileIconPreset;
  readonly sprite?: boolean;
  readonly className?: string;
}

/**
 * Renders a file or folder icon in either the rich multi-hue preset or the minimal stroke preset.
 * Accepts either a pre-resolved `icon` (best for virtualized rows) or an `entry`.
 */
export function FileTypeIcon({
  icon,
  entry,
  open = false,
  preset = "rich",
  sprite = false,
  className,
}: FileTypeIconProps) {
  const instanceId = useId();
  const resolved = icon ?? resolveFileIcon(entry ?? { name: "", type: "file" }, { open });
  const { rule } = resolved;

  if (preset === "stroke") {
    return <StrokeIcon name={rule.strokeIcon} className={className} sprite={sprite} />;
  }

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
