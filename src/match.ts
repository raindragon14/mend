export type MatchTier = 0 | 1 | 2;

export interface MatchResult {
  tier: MatchTier;
  positions: number[];
}

export interface ReplacementItem {
  kind: 'context' | 'add';
  oldIndex?: number;
  text: string;
}

function normalizeForTier(line: string, tier: MatchTier): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** Extract leading spaces and tabs from a line. */
export function leadingWhitespace(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

/** Check whether `oldLines` matches `fileLines` starting at `pos` under `tier`. */
export function matchesAt(
  fileLines: string[],
  oldLines: string[],
  pos: number,
  tier: MatchTier,
): boolean {
  if (pos < 0 || pos + oldLines.length > fileLines.length) return false;
  for (let j = 0; j < oldLines.length; j += 1) {
    if (normalizeForTier(fileLines[pos + j]!, tier) !== normalizeForTier(oldLines[j]!, tier)) {
      return false;
    }
  }
  return true;
}

/** Find all occurrences of non-empty `oldLines` in `fileLines[startIdx..]` at the first matching tier. */
export function findOccurrences(
  fileLines: string[],
  oldLines: string[],
  startIdx: number,
  strict: boolean,
): MatchResult | null {
  if (oldLines.length === 0) return null;
  const maxTier: MatchTier = strict ? 0 : 2;
  const limit = fileLines.length - oldLines.length;

  for (let tier: MatchTier = 0; tier <= maxTier; tier = (tier + 1) as MatchTier) {
    const positions: number[] = [];
    const normOld = oldLines.map((l) => normalizeForTier(l, tier));
    for (let i = startIdx; i <= limit; i += 1) {
      let ok = true;
      for (let j = 0; j < normOld.length; j += 1) {
        if (normalizeForTier(fileLines[i + j]!, tier) !== normOld[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) {
      return { tier, positions };
    }
  }
  return null;
}

/** Re-indent a non-context added line at tier 2 according to SPEC.md section 5. */
export function reindentLine(line: string, fileIndent: string, patchIndent: string): string {
  if (line.trim() !== '' && line.startsWith(patchIndent)) {
    return fileIndent + line.slice(patchIndent.length);
  }
  return line;
}

/** Build replacement lines preserving file context lines and applying tier-2 re-indentation to added lines. */
export function buildReplacement(
  fileLines: string[],
  oldLines: string[],
  pos: number,
  tier: MatchTier,
  items: ReplacementItem[],
): string[] {
  const fileIndent = leadingWhitespace(fileLines[pos]!);
  const patchIndent = leadingWhitespace(oldLines[0]!);
  return items.map((item) => {
    if (item.kind === 'context') {
      return fileLines[pos + item.oldIndex!]!;
    }
    return tier === 2 ? reindentLine(item.text, fileIndent, patchIndent) : item.text;
  });
}
