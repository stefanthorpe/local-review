export function repin(
  line: number,
  anchor: string,
  lines: string[],
): { line: number; outdated: boolean } {
  if (lines[line - 1]?.trim() === anchor) {
    return { line, outdated: false };
  }
  for (let distance = 1; distance <= 50; distance++) {
    for (const candidate of [line - distance, line + distance]) {
      if (candidate >= 1 && lines[candidate - 1]?.trim() === anchor) {
        return { line: candidate, outdated: false };
      }
    }
  }
  return { line, outdated: true };
}
