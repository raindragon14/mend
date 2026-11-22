import { readFileSync } from 'node:fs';
import { Exit2Error } from './types.ts';
import type { CliOptions, FormatOption } from './types.ts';

const VALID_FORMATS = new Set<string>(['auto', 'unified', 'search-replace', 'v4a', 'json']);

/** Parse mend CLI arguments according to SPEC.md section 1. */
export function parseArgs(args: string[]): CliOptions | null {
  let format: FormatOption | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let ended = false;

  for (const arg of args) {
    if (!ended && arg === '--') {
      ended = true;
      continue;
    }
    if (!ended && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && format === null) {
        const val = arg.slice('--format='.length);
        if (!VALID_FORMATS.has(val)) return null;
        format = val as FormatOption;
      } else if (arg === '--check' && !check) {
        check = true;
      } else if (arg === '--strict' && !strict) {
        strict = true;
      } else {
        return null;
      }
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) return null;

  const patchFile = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  return {
    format: format ?? 'auto',
    check,
    strict,
    patchFile,
  };
}

/** Read patch UTF-8 text from file or standard input. */
export function readPatchText(patchFile: string | null): string {
  try {
    return readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) {
      throw new Exit2Error('error: no-patch');
    }
    return '';
  }
}

/** Split patch text into lines as defined in SPEC.md section 3. */
export function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}
