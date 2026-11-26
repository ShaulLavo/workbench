import type { ActivationFocusDecision } from "@shaulavo/workbench-core";
import type { LinkLineSnapshot, LinkProviderRegistration, ProvidedLink, Terminal } from "ghostty-webgpu";

export interface TerminalFileReference {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

export interface TerminalSnapshotFileLink {
  readonly range: { readonly start: number; readonly end: number };
  readonly reference: TerminalFileReference;
  readonly text: string;
}

const TOKEN_BOUNDARY = new Set([" ", "\t", '"', "'", "`", "<", ">", "|", "(", ")", "[", "]", "{", "}"]);
const TRAILING_PUNCTUATION = new Set([".", ",", ":", ";", "!", "?"]);
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:\/\//;
const HOSTNAME_RE = /^(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|edu|gov|local|localhost)$/i;
const MAX_CANDIDATE_LENGTH = 1024;

function stripTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(token[end - 1] ?? "")) {
    end -= 1;
  }
  return token.slice(0, end);
}

function peelDiagnosticLabel(token: string): { readonly shift: number; readonly text: string } {
  const colon = token.indexOf(":");
  if (colon <= 0) return { shift: 0, text: token };
  const prefix = token.slice(0, colon);
  if (prefix.includes("/") || prefix.includes(".")) return { shift: 0, text: token };
  const rest = token.slice(colon + 1);
  const bare = stripLineCol(rest).path;
  const leaf = bare.slice(bare.lastIndexOf("/") + 1);
  if (!hasValidFileExtension(leaf)) return { shift: 0, text: token };
  return { shift: colon + 1, text: rest };
}

function stripLineCol(candidate: string): TerminalFileReference {
  const parts = candidate.split(":");
  if (parts.length >= 3) {
    const colStr = parts.at(-1) ?? "";
    const lineStr = parts.at(-2) ?? "";
    if (/^\d+$/.test(lineStr) && /^\d+$/.test(colStr)) {
      const path = parts.slice(0, -2).join(":");
      if (path) {
        return { path, line: Number(lineStr), column: Number(colStr) };
      }
    }
  }
  if (parts.length >= 2) {
    const lineStr = parts.at(-1) ?? "";
    if (/^\d+$/.test(lineStr)) {
      const path = parts.slice(0, -1).join(":");
      if (path) return { path, line: Number(lineStr) };
    }
  }
  return { path: candidate };
}

function hasValidFileExtension(leaf: string): boolean {
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0 || dot === leaf.length - 1) return false;
  const ext = leaf.slice(dot + 1);
  // Reject purely numeric suffixes (e.g. Mozilla/5.0, v18.2.0).
  if (/^\d+$/.test(ext)) return false;
  return /^[A-Za-z][A-Za-z0-9_-]{0,11}$/.test(ext);
}

/** Parses one terminal token into a file reference (`path[:line[:col]]`) or `null` if not file-shaped. */
export function parseTerminalFileReference(rawToken: string): TerminalFileReference | null {
  if (!rawToken || rawToken.length > MAX_CANDIDATE_LENGTH) return null;
  if (URL_SCHEME_RE.test(rawToken)) return null;
  const trimmed = stripTrailingPunctuation(rawToken);
  if (!trimmed) return null;
  const { text } = peelDiagnosticLabel(trimmed);
  const ref = stripLineCol(text);
  const bare = ref.path;
  if (!bare || HOSTNAME_RE.test(bare)) return null;
  const leaf = bare.slice(bare.lastIndexOf("/") + 1);
  if (!hasValidFileExtension(leaf)) return null;
  if (!bare.includes("/") && ref.line === undefined) {
    // Bare filenames without a directory require a recognized extension and no leading punctuation.
    if (!/^[A-Za-z0-9._-]+$/.test(bare)) return null;
  }
  return ref;
}

function matchSnapshotToken(
  line: Pick<LinkLineSnapshot, "text" | "startCellByTextBoundary" | "endCellByTextBoundary">,
  start: number,
  end: number,
): TerminalSnapshotFileLink | null {
  const trimmed = stripTrailingPunctuation(line.text.slice(start, end));
  if (trimmed.length === 0 || trimmed.length > MAX_CANDIDATE_LENGTH || URL_SCHEME_RE.test(trimmed)) {
    return null;
  }
  const { shift, text: candidate } = peelDiagnosticLabel(trimmed);
  const ref = parseTerminalFileReference(candidate);
  if (!ref) return null;
  const matchStart = start + shift;
  const matchEnd = matchStart + candidate.length;
  const startCell = line.startCellByTextBoundary[matchStart];
  const endCell = line.endCellByTextBoundary[matchEnd];
  if (startCell === undefined || endCell === undefined) return null;
  return {
    range: { start: startCell, end: endCell },
    reference: ref,
    text: candidate,
  };
}

/** Scans one Ghostty `LinkLineSnapshot` in a single linear pass for clickable file references. */
export function findTerminalSnapshotFileLinks(
  line: Pick<LinkLineSnapshot, "text" | "startCellByTextBoundary" | "endCellByTextBoundary">,
): TerminalSnapshotFileLink[] {
  const text = line.text;
  const results: TerminalSnapshotFileLink[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    if (TOKEN_BOUNDARY.has(text[cursor] ?? "")) {
      cursor += 1;
      continue;
    }
    let end = cursor;
    while (end < text.length && !TOKEN_BOUNDARY.has(text[end] ?? "")) {
      end += 1;
    }
    const matched = matchSnapshotToken(line, cursor, end);
    if (matched) results.push(matched);
    cursor = end;
  }

  return results;
}

export interface RegisterTerminalFileLinksOptions {
  readonly resolveFileLink: (rawPath: string) => Promise<string | null>;
  readonly openFileLink: (
    path: string,
    location: { readonly line?: number; readonly column?: number } | undefined,
    focus: ActivationFocusDecision,
  ) => void;
  readonly onUnresolved?: (rawPath: string) => void;
}

/** Registers a Ghostty link provider that verifies workspace file paths before opening them. */
export function registerTerminalFileLinks(
  terminal: Terminal,
  options: RegisterTerminalFileLinksOptions,
): LinkProviderRegistration {
  let clickSeq = 0;
  let disposed = false;

  async function activateLink(link: TerminalSnapshotFileLink): Promise<void> {
    if (disposed) return;
    clickSeq += 1;
    const mySeq = clickSeq;
    let resolved: string | null = null;
    try {
      resolved = await options.resolveFileLink(link.reference.path);
    } catch {
      resolved = null;
    }
    if (disposed || clickSeq !== mySeq) return;
    if (!resolved) {
      options.onUnresolved?.(link.reference.path);
      return;
    }
    const location =
      link.reference.line !== undefined
        ? { line: link.reference.line, column: link.reference.column }
        : undefined;
    options.openFileLink(resolved, location, { shouldFocusEditor: true, origin: "mouse" });
  }

  const registration = terminal.registerLinkProvider({
    provideLinks(line): readonly ProvidedLink<Event>[] | undefined {
      if (disposed) return undefined;
      const matches = findTerminalSnapshotFileLinks(line);
      if (matches.length === 0) return undefined;
      return matches.map((match) => ({
        range: match.range,
        text: match.text,
        activate: () => {
          void activateLink(match);
        },
      }));
    },
  });

  return {
    token: registration.token,
    dispose() {
      disposed = true;
      clickSeq += 1;
      registration.dispose();
    },
  };
}
