import type { FormatName } from './types.ts';

/** Detect patch format from patch lines according to SPEC.md section 4. */
export function detectFormat(lines: string[]): FormatName | null {
  const firstNonBlank = lines.findIndex((line) => line.trim() !== '');
  if (firstNonBlank < 0) return null;

  if (lines[firstNonBlank]!.trim() === '*** Begin Patch') {
    return 'v4a';
  }

  const firstChar = lines[firstNonBlank]!.trimStart()[0];
  if (firstChar === '[' || firstChar === '{') {
    return 'json';
  }

  if (lines.some((line) => line.trimEnd() === '<<<<<<< SEARCH')) {
    return 'search-replace';
  }

  if (
    lines.some(
      (line, idx) =>
        line.startsWith('diff --git ') ||
        (line.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }

  return null;
}
