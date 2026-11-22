import { buildReplacement, findOccurrences, matchesAt } from './match.ts';
import type { MatchTier, ReplacementItem } from './match.ts';
import { isSafePath, parseFileLines, serializeFileLines } from './tree.ts';
import { EditFailError, Exit2Error } from './types.ts';
import type { Edit } from './types.ts';

interface V4ABodyLine {
  kind: ' ' | '-' | '+';
  text: string;
}

interface V4AChunk {
  anchor: string;
  items: V4ABodyLine[];
  eof: boolean;
}

type V4ASection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4AChunk[] };

interface IndexedLine {
  lineNo: number;
  text: string;
}

function parseBodyLine(line: string): V4ABodyLine | null {
  if (line === '') return { kind: ' ', text: '' };
  const ch = line[0];
  if (ch === ' ' || ch === '-' || ch === '+') {
    return { kind: ch, text: line.slice(1) };
  }
  return null;
}

function parseUpdateSection(
  path: string,
  headerLineNo: number,
  secLines: IndexedLine[],
): V4ASection {
  let idx = 0;
  let moveTo: string | null = null;

  if (idx < secLines.length && secLines[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = secLines[idx]!.text.slice('*** Move to: '.length).trim();
    idx += 1;
  }

  const chunks: V4AChunk[] = [];

  while (idx < secLines.length) {
    const cur = secLines[idx]!;
    let anchor = '';
    const items: V4ABodyLine[] = [];
    let eof = false;

    if (cur.text.startsWith('@@')) {
      anchor = cur.text.slice(2).trim();
      idx += 1;
    } else if (chunks.length === 0) {
      const parsed = parseBodyLine(cur.text);
      if (parsed === null) {
        throw new Exit2Error(`error: parse ${cur.lineNo}`);
      }
      items.push(parsed);
      idx += 1;
    } else {
      throw new Exit2Error(`error: parse ${cur.lineNo}`);
    }

    while (idx < secLines.length) {
      const next = secLines[idx]!;
      if (next.text.startsWith('@@')) {
        break;
      }
      if (next.text.trimEnd() === '*** End of File') {
        eof = true;
        idx += 1;
        break;
      }
      const parsed = parseBodyLine(next.text);
      if (parsed === null) {
        throw new Exit2Error(`error: parse ${next.lineNo}`);
      }
      items.push(parsed);
      idx += 1;
    }

    chunks.push({ anchor, items, eof });
  }

  if (chunks.length === 0 && moveTo === null) {
    throw new Exit2Error(`error: parse ${headerLineNo}`);
  }

  return { kind: 'update', path, moveTo, chunks };
}

function buildV4AEdit(sec: V4ASection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    return (tree) => {
      if (!isSafePath(sec.path)) throw new EditFailError('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new EditFailError('exists', sec.path);
      tree.set(sec.path, serializeFileLines(sec.lines, '\n', true));
    };
  }

  if (sec.kind === 'delete') {
    return (tree) => {
      if (!isSafePath(sec.path)) throw new EditFailError('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new EditFailError('missing', sec.path);
      tree.set(sec.path, null);
    };
  }

  return (tree) => {
    if (!isSafePath(sec.path)) throw new EditFailError('unsafe', sec.path);
    if (sec.moveTo !== null && !isSafePath(sec.moveTo)) {
      throw new EditFailError('unsafe', sec.moveTo);
    }

    const before = tree.get(sec.path);
    if (before === null) throw new EditFailError('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) {
      throw new EditFailError('exists', sec.moveTo);
    }

    const parsed = parseFileLines(before);
    const lines = [...parsed.lines];
    let cursor = 0;

    for (const chunk of sec.chunks) {
      if (chunk.anchor !== '') {
        const anchorMatch = findOccurrences(lines, [chunk.anchor], cursor, strict);
        if (anchorMatch === null) throw new EditFailError('no-match', sec.path);
        cursor = anchorMatch.positions[0]! + 1;
      }

      const oldLines: string[] = [];
      const repItems: ReplacementItem[] = [];
      for (const item of chunk.items) {
        if (item.kind === ' ') {
          const oldIdx = oldLines.length;
          oldLines.push(item.text);
          repItems.push({ kind: 'context', oldIndex: oldIdx, text: item.text });
        } else if (item.kind === '-') {
          oldLines.push(item.text);
        } else {
          repItems.push({ kind: 'add', text: item.text });
        }
      }

      if (oldLines.length === 0) {
        const insertAt = chunk.eof ? lines.length : cursor;
        const replacement = repItems.map((it) => it.text);
        lines.splice(insertAt, 0, ...replacement);
        cursor = insertAt + replacement.length;
      } else {
        let pos = -1;
        let tier: MatchTier = 0;

        if (chunk.eof) {
          const targetPos = lines.length - oldLines.length;
          if (targetPos < cursor) throw new EditFailError('no-match', sec.path);
          const maxTier: MatchTier = strict ? 0 : 2;
          let found = false;
          for (let t: MatchTier = 0; t <= maxTier; t = (t + 1) as MatchTier) {
            if (matchesAt(lines, oldLines, targetPos, t)) {
              pos = targetPos;
              tier = t;
              found = true;
              break;
            }
          }
          if (!found) throw new EditFailError('no-match', sec.path);
        } else {
          const match = findOccurrences(lines, oldLines, cursor, strict);
          if (match === null) throw new EditFailError('no-match', sec.path);
          pos = match.positions[0]!;
          tier = match.tier;
        }

        const replacement = buildReplacement(lines, oldLines, pos, tier, repItems);
        lines.splice(pos, oldLines.length, ...replacement);
        cursor = pos + replacement.length;
      }
    }

    const out = serializeFileLines(lines, parsed.eol, parsed.endsWithBreak);
    if (sec.moveTo !== null) {
      tree.set(sec.path, null);
      tree.set(sec.moveTo, out);
      tree.recordMove(sec.path, sec.moveTo);
    } else {
      tree.set(sec.path, out);
    }
  };
}

/** Parse a V4A patch into edits according to SPEC.md section 8. */
export function parseV4AEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new Exit2Error('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') {
    throw new Exit2Error(`error: parse ${first + 1}`);
  }

  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (lines[k]!.trim() !== '') {
      last = k;
      break;
    }
  }
  if (last <= first || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2Error(`error: parse ${lines.length + 1}`);
  }

  type RawSection = {
    kind: 'add' | 'delete' | 'update';
    path: string;
    headerLineNo: number;
    body: IndexedLine[];
  };

  const rawSections: RawSection[] = [];
  let current: RawSection | null = null;

  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const lineNo = i + 1;

    if (line.startsWith('*** Add File: ')) {
      current = {
        kind: 'add',
        path: line.slice('*** Add File: '.length).trim(),
        headerLineNo: lineNo,
        body: [],
      };
      rawSections.push(current);
    } else if (line.startsWith('*** Delete File: ')) {
      current = {
        kind: 'delete',
        path: line.slice('*** Delete File: '.length).trim(),
        headerLineNo: lineNo,
        body: [],
      };
      rawSections.push(current);
    } else if (line.startsWith('*** Update File: ')) {
      current = {
        kind: 'update',
        path: line.slice('*** Update File: '.length).trim(),
        headerLineNo: lineNo,
        body: [],
      };
      rawSections.push(current);
    } else if (current === null) {
      if (line.trim() !== '') {
        throw new Exit2Error(`error: parse ${lineNo}`);
      }
    } else {
      current.body.push({ lineNo, text: line });
    }
  }

  const sections: V4ASection[] = rawSections.map((raw) => {
    const body = raw.body;
    while (body.length > 0 && body[body.length - 1]!.text.trim() === '') {
      body.pop();
    }

    if (raw.kind === 'add') {
      const addLines: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) {
          addLines.push(b.text.slice(1));
        } else if (b.text === '') {
          addLines.push('');
        } else {
          throw new Exit2Error(`error: parse ${b.lineNo}`);
        }
      }
      return { kind: 'add', path: raw.path, lines: addLines };
    }

    if (raw.kind === 'delete') {
      if (body.length > 0) {
        throw new Exit2Error(`error: parse ${body[0]!.lineNo}`);
      }
      return { kind: 'delete', path: raw.path };
    }

    return parseUpdateSection(raw.path, raw.headerLineNo, body);
  });

  return sections.map((sec) => buildV4AEdit(sec, strict));
}
