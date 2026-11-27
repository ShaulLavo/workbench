/** Joins truthy class names without external dependencies. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    out = out ? `${out} ${part}` : part;
  }
  return out;
}
