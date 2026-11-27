import { useEffect } from "react";
import { buildFileIconSpriteMarkup } from "./resolver";

interface DocumentSpriteRecord {
  count: number;
  readonly host: SVGSVGElement;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const spritesByDocument = new WeakMap<Document, DocumentSpriteRecord>();

function createSpriteNode(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-wb-icon-sprite", "");
  svg.setAttribute("focusable", "false");
  svg.style.position = "absolute";
  svg.style.width = "0";
  svg.style.height = "0";
  svg.style.overflow = "hidden";
  svg.style.pointerEvents = "none";
  svg.innerHTML = buildFileIconSpriteMarkup();
  return svg;
}

/**
 * Acquires a reference-counted `<svg data-wb-icon-sprite>` host mounted into `doc.body`.
 * Multiple consumers across `.`, `./icons`, and `./tree` share one sprite per `Document`.
 */
export function acquireFileIconSprite(doc: Document): () => void {
  let record = spritesByDocument.get(doc);
  if (!record || !record.host.isConnected) {
    const host = createSpriteNode(doc);
    (doc.body ?? doc.documentElement).appendChild(host);
    record = { count: 0, host };
    spritesByDocument.set(doc, record);
  }
  record.count += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = spritesByDocument.get(doc);
    if (!current || current !== record) return;
    current.count -= 1;
    if (current.count <= 0) {
      current.host.remove();
      spritesByDocument.delete(doc);
    }
  };
}

/** Ensures the shared per-`Document` file icon sprite is mounted while `enabled` is true. */
export function useEnsureFileIconSprite(doc: Document | null, enabled = true): void {
  useEffect(() => {
    if (!enabled || !doc) return;
    return acquireFileIconSprite(doc);
  }, [doc, enabled]);
}
