const COMPOUND_EXT_RE = /\.(?:test|spec|stories|config|module|d)\.[a-z0-9]+$/i;
const MAX_EXTENSION_LEN = 11;

/** Normalizes a project-relative path by removing leading and trailing slashes. */
export function normalizeTreePath(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && raw.charCodeAt(start) === 47) start += 1;
  while (end > start && raw.charCodeAt(end - 1) === 47) end -= 1;
  return start === 0 && end === raw.length ? raw : raw.slice(start, end);
}

/** Immediate parent directory path (`""` for root-level entries). */
export function parentOf(treePath: string): string {
  const slash = treePath.lastIndexOf("/");
  return slash === -1 ? "" : treePath.slice(0, slash);
}

/** Final path segment. */
export function baseName(treePath: string): string {
  const slash = treePath.lastIndexOf("/");
  return slash === -1 ? treePath : treePath.slice(slash + 1);
}

/** Joins a parent directory (`""` for root) with a child segment. */
export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Ordered ancestor directory paths from outermost to immediate parent (excluding `""`). */
export function ancestorsOf(treePath: string): string[] {
  const result: string[] = [];
  let cursor = treePath.indexOf("/");
  while (cursor !== -1) {
    result.push(treePath.slice(0, cursor));
    cursor = treePath.indexOf("/", cursor + 1);
  }
  return result;
}

/** True when `candidate` is strictly inside `ancestor` (`""` contains every non-empty path). */
export function isInside(candidate: string, ancestor: string): boolean {
  if (ancestor === "") return candidate !== "";
  return (
    candidate.length > ancestor.length &&
    candidate.startsWith(ancestor) &&
    candidate.charCodeAt(ancestor.length) === 47
  );
}

/** True when `candidate` equals `ancestor` or sits inside it. */
export function isSameOrInside(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || isInside(candidate, ancestor);
}

/** Splits a filename into a truncatable stem and a preserved extension (`.tsx`, `.test.ts`, `.d.ts`). */
export function splitFilename(name: string): { readonly stem: string; readonly ext: string } {
  const compound = COMPOUND_EXT_RE.exec(name);
  if (compound && compound.index > 0 && compound[0].length <= MAX_EXTENSION_LEN + 2) {
    return { stem: name.slice(0, compound.index), ext: compound[0] };
  }
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  const ext = name.slice(dot);
  if (ext.length > MAX_EXTENSION_LEN) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext };
}

/** Initial selection span `[start, end]` covering the filename stem without its final extension. */
export function renameSelection(name: string): readonly [number, number] {
  const dot = name.lastIndexOf(".");
  return [0, dot > 0 ? dot : name.length];
}

export type EntryNameProblem = "empty" | "slash" | "dot" | "duplicate";

/** Validates an inline create/rename entry name against path-safety rules and sibling collisions. */
export function validateEntryName(
  rawName: string,
  siblingNames: ReadonlySet<string>,
  currentName?: string,
): EntryNameProblem | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) return "empty";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "slash";
  if (trimmed === "." || trimmed === "..") return "dot";
  if (trimmed !== currentName && siblingNames.has(trimmed)) return "duplicate";
  return undefined;
}

export function entryNameProblemMessage(problem: EntryNameProblem | undefined): string | undefined {
  if (!problem) return undefined;
  if (problem === "empty") return "Enter a name";
  if (problem === "slash") return "Names cannot contain slashes";
  if (problem === "dot") return "Choose a valid file or folder name";
  return "An item with that name already exists";
}

/** Fast deterministic case-insensitive comparator (directories before files). */
export function compareDirEntries(
  left: { readonly name: string; readonly kind: "file" | "directory" },
  right: { readonly name: string; readonly kind: "file" | "directory" },
): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  const a = left.name;
  const b = right.name;
  const minLen = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < minLen; i += 1) {
    let ca = a.charCodeAt(i);
    let cb = b.charCodeAt(i);
    if (ca >= 65 && ca <= 90) ca += 32;
    if (cb >= 65 && cb <= 90) cb += 32;
    if (ca !== cb) return ca - cb;
  }
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
