import type { EditorPlugin } from "@singapore-editor/core/extensions";
import type { InlineReplacementSpec } from "@singapore-editor/core/rendering";

export interface ComposerMentionItem {
  readonly id: string;
  readonly path: string;
  readonly label?: string;
  readonly detail?: string;
}

export interface ComposerSlashCommand {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly insertText?: string;
}

export interface ComposerMentionRange {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly path: string;
  readonly label: string;
}

export interface ComposerTriggerMatch {
  readonly kind: "mention" | "slash";
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** Formats a workspace file path into its canonical `@`-mention text token. */
export function formatMentionToken(filePath: string): string {
  const normalized = filePath.trim();
  if (!normalized) return "";
  return /\s/.test(normalized) ? `@[${normalized}]` : `@${normalized}`;
}

function basenameLabel(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash >= 0 ? filePath.slice(slash + 1) : filePath;
}

function isTokenLeadBoundary(ch: string | undefined): boolean {
  return ch === undefined || /\s|[([{]/.test(ch);
}

function matchBracketMention(
  text: string,
  start: number,
  knownPaths?: ReadonlySet<string>,
): ComposerMentionRange | null {
  if (text[start + 1] !== "[") return null;
  const close = text.indexOf("]", start + 2);
  if (close <= start + 2) return null;
  const path = text.slice(start + 2, close);
  if (knownPaths && !knownPaths.has(path)) return null;
  const end = close + 1;
  return { start, end, raw: text.slice(start, end), path, label: `@${basenameLabel(path)}` };
}

/**
 * Scans prompt text for canonical `@path` / `@[path with spaces]` file mentions while ignoring
 * email addresses (`user@example.com`). When `knownPaths` is supplied, only matching paths become
 * chips; otherwise any path containing `/` or a file extension (`name.ext`) qualifies.
 */
export function findMentionRanges(
  text: string,
  knownPaths?: ReadonlySet<string>,
): readonly ComposerMentionRange[] {
  const out: ComposerMentionRange[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "@" || !isTokenLeadBoundary(i > 0 ? text[i - 1] : undefined)) {
      i += 1;
      continue;
    }

    if (text[i + 1] === "[") {
      const bracketMatch = matchBracketMention(text, i, knownPaths);
      if (bracketMatch) {
        out.push(bracketMatch);
        i = bracketMatch.end;
      } else {
        i += 1;
      }
      continue;
    }

    let end = i + 1;
    while (end < text.length && !/[\s)\]},;!?]/.test(text[end] ?? "")) {
      end += 1;
    }
    const path = text.slice(i + 1, end);
    const qualifies = knownPaths
      ? knownPaths.has(path)
      : path.length > 0 && (path.includes("/") || /^[^./][^/]*\.[A-Za-z][A-Za-z0-9_-]{0,9}$/.test(path));
    if (qualifies) {
      out.push({ start: i, end, raw: text.slice(i, end), path, label: `@${basenameLabel(path)}` });
      i = end;
      continue;
    }
    i += 1;
  }

  return out;
}

/**
 * Detects an active `@query` mention trigger or `/query` slash-command trigger ending at `cursorOffset`.
 */
export function findTriggerAtCursor(text: string, cursorOffset: number): ComposerTriggerMatch | null {
  const clamped = Math.max(0, Math.min(cursorOffset, text.length));
  let start = clamped;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) {
    start -= 1;
  }
  if (start >= clamped) return null;
  const token = text.slice(start, clamped);
  if (token.startsWith("@")) {
    return { kind: "mention", start, end: clamped, query: token.slice(1) };
  }
  if (token.startsWith("/")) {
    return { kind: "slash", start, end: clamped, query: token.slice(1) };
  }
  return null;
}

/**
 * Singapore `EditorPlugin` rendering canonical `@file` mention spans as atomic inline replacement
 * chips (`reveal: "never"`, `atomic: true`, stable `key`) evaluated on every edit so Backspace,
 * Delete, Left/Right arrows, and copy/paste operate atomically while keeping canonical `@path` text.
 */
export function createMentionInlineReplacementPlugin(options?: {
  readonly getKnownPaths?: () => ReadonlySet<string> | undefined;
}): EditorPlugin {
  return {
    name: "workbench.composer-mentions",
    activate(context) {
      return context.registerInlineReplacementProvider(
        ({ textSnapshot }) => {
          const text = textSnapshot.readRange(0, textSnapshot.length);
          const mentions = findMentionRanges(text, options?.getKnownPaths?.());
          if (mentions.length === 0) return [];
          return mentions.map((mention): InlineReplacementSpec => ({
            id: `mention:${mention.start}:${mention.end}`,
            key: `mention:${mention.path}:${mention.start}`,
            startIndex: mention.start,
            endIndex: mention.end,
            text: mention.label,
            kind: "mention",
            className: "wb-composer-mention-chip",
            reveal: "never",
            atomic: true,
            render(container, displayText) {
              const chip = document.createElement("span");
              chip.className = "wb-composer-mention-chip-inner";
              chip.dataset.wbMentionChip = mention.path;
              chip.textContent = displayText;
              chip.title = mention.path;
              container.replaceChildren(chip);
              return {
                dispose() {
                  container.replaceChildren();
                },
              };
            },
          }));
        },
        { trigger: "edit" },
      );
    },
  };
}
