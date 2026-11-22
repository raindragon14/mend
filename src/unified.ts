import { buildReplacement, findOccurrences } from './match.ts';
import type { ReplacementItem } from './match.ts';
import { isSafePath, parseFileLines, serializeFileLines } from './tree.ts';
import { EditFailError, Exit2Error } from './types.ts';
import type { Edit } from './types.ts';

interface HunkBodyItem {
  kind: ' ' | '-' | '+';
  text: string;
  noNewlineAfter: boolean;
}

interface UnifiedHunk {
  oldStart: number;
  items: HunkBodyItem[];
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  headerOld: string | null;
  headerNew: string | null;
  hasDashPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isNewFile: boolean;
  isDeletedFile: boolean;
  hunks: UnifiedHunk[];
  inHeader: boolean;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseDiffGitLine(line: string): { oldPath: string; newPath: string } | null {
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;

  if (rest.length >= 5 && rest.length % 2 === 1) {
    const mid = (rest.length - 1) / 2;
    if (rest[mid] === ' ' && rest.slice(mid + 1, mid + 3) === 'b/') {
      const left = rest.slice(2, mid);
      const right = rest.slice(mid + 3);
      if (left === right && left.length > 0) {
        return { oldPath: left, newPath: right };
      }
    }
  }

  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) return null;
  const oldPath = rest.slice(2, sep);
  const newPath = rest.slice(sep + 3);
  if (oldPath === '' || newPath === '') return null;
  return { oldPath, newPath };
}

function parseHeaderPath(line: string): string {
  let rest = line.slice(4);
  const tabIdx = rest.indexOf('\t');
  if (tabIdx >= 0) rest = rest.slice(0, tabIdx);
  rest = rest.trim();
  if (rest === '/dev/null') return '/dev/null';
  if (rest.startsWith('a/') || rest.startsWith('b/')) return rest.slice(2);
  return rest;
}

function makeSection(gitOld: string | null, gitNew: string | null): UnifiedSection {
  return {
    gitOld,
    gitNew,
    headerOld: null,
    headerNew: null,
    hasDashPair: false,
    renameFrom: null,
    renameTo: null,
    isNewFile: false,
    isDeletedFile: false,
    hunks: [],
    inHeader: true,
  };
}

function partitionHunkItems(items: HunkBodyItem[]): {
  oldLines: string[];
  repItems: ReplacementItem[];
  lastOutputNoNewline: boolean;
} {
  const oldLines: string[] = [];
  const repItems: ReplacementItem[] = [];
  let lastOutputNoNewline = false;

  for (const item of items) {
    if (item.kind === ' ') {
      const oldIdx = oldLines.length;
      oldLines.push(item.text);
      repItems.push({ kind: 'context', oldIndex: oldIdx, text: item.text });
      lastOutputNoNewline = item.noNewlineAfter;
    } else if (item.kind === '-') {
      oldLines.push(item.text);
    } else {
      repItems.push({ kind: 'add', text: item.text });
      lastOutputNoNewline = item.noNewlineAfter;
    }
  }

  return { oldLines, repItems, lastOutputNoNewline };
}

function buildSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  const oldPath = sec.headerOld ?? sec.renameFrom ?? sec.gitOld ?? '';
  const newPath = sec.headerNew ?? sec.renameTo ?? sec.gitNew ?? '';

  if (oldPath === '/dev/null' || sec.isNewFile) {
    return (tree) => {
      if (!isSafePath(newPath)) throw new EditFailError('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new EditFailError('exists', newPath);
      const addedLines: string[] = [];
      let lastNoNewline = false;
      for (const h of sec.hunks) {
        for (const item of h.items) {
          if (item.kind === '+') {
            addedLines.push(item.text);
            lastNoNewline = item.noNewlineAfter;
          }
        }
      }
      const text = serializeFileLines(addedLines, '\n', !lastNoNewline);
      tree.set(newPath, text);
    };
  }

  if (newPath === '/dev/null' || sec.isDeletedFile) {
    return (tree) => {
      if (!isSafePath(oldPath)) throw new EditFailError('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new EditFailError('missing', oldPath);
      tree.set(oldPath, null);
    };
  }

  const isMove = oldPath !== newPath;

  return (tree) => {
    if (!isSafePath(oldPath)) throw new EditFailError('unsafe', oldPath);
    if (isMove && !isSafePath(newPath)) throw new EditFailError('unsafe', newPath);

    const before = tree.get(oldPath);
    if (before === null) throw new EditFailError('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new EditFailError('exists', newPath);

    const parsed = parseFileLines(before);
    const lines = [...parsed.lines];
    let endsWithBreak = parsed.endsWithBreak;
    let delta = 0;

    for (const h of sec.hunks) {
      const { oldLines, repItems, lastOutputNoNewline } = partitionHunkItems(h.items);

      if (oldLines.length > 0) {
        const match = findOccurrences(lines, oldLines, 0, strict);
        if (match === null) throw new EditFailError('no-match', oldPath);

        const target = h.oldStart - 1 + delta;
        let bestPos = match.positions[0]!;
        let bestDist = Math.abs(bestPos - target);
        for (let k = 1; k < match.positions.length; k += 1) {
          const pos = match.positions[k]!;
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            bestDist = dist;
            bestPos = pos;
          }
        }

        const replacement = buildReplacement(lines, oldLines, bestPos, match.tier, repItems);
        const touchesEof = bestPos + oldLines.length === lines.length;
        lines.splice(bestPos, oldLines.length, ...replacement);
        delta += replacement.length - oldLines.length;
        if (touchesEof) {
          endsWithBreak = !lastOutputNoNewline;
        }
      } else {
        const insertAt = Math.max(0, Math.min(h.oldStart + delta, lines.length));
        const touchesEof = insertAt === lines.length;
        const replacement = repItems.map((it) => it.text);
        lines.splice(insertAt, 0, ...replacement);
        delta += replacement.length;
        if (touchesEof) {
          endsWithBreak = !lastOutputNoNewline;
        }
      }
    }

    const out = sec.hunks.length === 0 ? before : serializeFileLines(lines, parsed.eol, endsWithBreak);
    if (isMove) {
      tree.set(oldPath, null);
      tree.set(newPath, out);
      tree.recordMove(oldPath, newPath);
    } else {
      tree.set(oldPath, out);
    }
  };
}

/** Parse a unified diff into edits according to SPEC.md section 6. */
export function parseUnifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let current: UnifiedSection | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const parsed = parseDiffGitLine(line);
      if (parsed === null) {
        throw new Exit2Error(`error: parse ${i + 1}`);
      }
      current = makeSection(parsed.oldPath, parsed.newPath);
      sections.push(current);
      i += 1;
      continue;
    }

    const nextLine = i + 1 < lines.length ? lines[i + 1]! : null;
    if (line.startsWith('--- ')) {
      if (nextLine !== null && nextLine.startsWith('+++ ')) {
        if (current === null || !current.inHeader || current.hasDashPair) {
          current = makeSection(null, null);
          sections.push(current);
        }
        current.headerOld = parseHeaderPath(line);
        current.headerNew = parseHeaderPath(nextLine);
        current.hasDashPair = true;
        i += 2;
        continue;
      }
      if (current !== null && current.inHeader) {
        throw new Exit2Error(`error: parse ${i + 2}`);
      }
      i += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      const m = HUNK_HEADER_RE.exec(line);
      if (m === null || current === null) {
        throw new Exit2Error(`error: parse ${i + 1}`);
      }
      current.inHeader = false;
      const oldStart = Number(m[1]);
      i += 1;

      const rawBody: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          rawBody.push(b);
          i += 1;
        } else {
          break;
        }
      }

      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') {
        rawBody.pop();
      }

      const items: HunkBodyItem[] = [];
      for (const b of rawBody) {
        if (b.startsWith('\\')) {
          if (items.length > 0) {
            items[items.length - 1]!.noNewlineAfter = true;
          }
        } else if (b === '') {
          items.push({ kind: ' ', text: '', noNewlineAfter: false });
        } else {
          const prefix = b[0] as ' ' | '-' | '+';
          items.push({ kind: prefix, text: b.slice(1), noNewlineAfter: false });
        }
      }

      current.hunks.push({ oldStart, items });
      continue;
    }

    if (current !== null && current.inHeader) {
      if (line.startsWith('rename from ')) {
        current.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        current.renameTo = line.slice('rename to '.length).trim();
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        current.isNewFile = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        current.isDeletedFile = true;
      }
    }

    i += 1;
  }

  return sections.map((sec) => buildSectionEdit(sec, strict));
}
