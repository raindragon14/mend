import { buildReplacement, findOccurrences } from './match.ts';
import type { ReplacementItem } from './match.ts';
import { isSafePath, parseFileLines, serializeFileLines } from './tree.ts';
import { EditFailError, Exit2Error } from './types.ts';
import type { Edit } from './types.ts';

interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function buildSearchReplaceEdit(block: SearchReplaceBlock, strict: boolean): Edit {
  const { path, oldLines, newLines } = block;
  if (oldLines.length === 0) {
    return (tree) => {
      if (!isSafePath(path)) throw new EditFailError('unsafe', path);
      if (tree.get(path) !== null) throw new EditFailError('exists', path);
      tree.set(path, serializeFileLines(newLines, '\n', true));
    };
  }

  return (tree) => {
    if (!isSafePath(path)) throw new EditFailError('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new EditFailError('missing', path);

    const parsed = parseFileLines(before);
    const match = findOccurrences(parsed.lines, oldLines, 0, strict);
    if (match === null) throw new EditFailError('no-match', path);
    if (match.positions.length > 1) throw new EditFailError('ambiguous', path);

    const pos = match.positions[0]!;
    const repItems: ReplacementItem[] = newLines.map((text) => ({ kind: 'add', text }));
    const replacement = buildReplacement(parsed.lines, oldLines, pos, match.tier, repItems);
    const lines = [...parsed.lines];
    lines.splice(pos, oldLines.length, ...replacement);
    tree.set(path, serializeFileLines(lines, parsed.eol, parsed.endsWithBreak));
  };
}

/** Parse SEARCH/REPLACE blocks into edits according to SPEC.md section 7. */
export function parseSearchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchReplaceBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }

    const searchIdx = i;
    let blockPath: string | null = null;
    for (let k = searchIdx - 1; k > prevEnd; k -= 1) {
      const trimmed = lines[k]!.trim();
      if (trimmed !== '' && !trimmed.startsWith('```')) {
        blockPath = trimmed;
        break;
      }
    }
    if (blockPath === null) {
      blockPath = prevPath;
    }
    if (blockPath === null) {
      throw new Exit2Error(`error: parse ${searchIdx + 1}`);
    }

    let eqIdx = -1;
    for (let k = searchIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eqIdx = k;
        break;
      }
    }
    if (eqIdx < 0) {
      throw new Exit2Error(`error: parse ${searchIdx + 1}`);
    }

    let replaceIdx = -1;
    for (let k = eqIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        replaceIdx = k;
        break;
      }
    }
    if (replaceIdx < 0) {
      throw new Exit2Error(`error: parse ${searchIdx + 1}`);
    }

    blocks.push({
      path: blockPath,
      oldLines: lines.slice(searchIdx + 1, eqIdx),
      newLines: lines.slice(eqIdx + 1, replaceIdx),
    });

    prevEnd = replaceIdx;
    prevPath = blockPath;
    i = replaceIdx + 1;
  }

  return blocks.map((b) => buildSearchReplaceEdit(b, strict));
}
