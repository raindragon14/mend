import { splitPatchLines } from './cli.ts';
import { isSafePath } from './tree.ts';
import { EditFailError, Exit2Error } from './types.ts';
import type { Edit, TreeInterface } from './types.ts';

function requireExistingFile(tree: TreeInterface, path: string): string {
  if (!isSafePath(path)) throw new EditFailError('unsafe', path);
  const content = tree.get(path);
  if (content === null) throw new EditFailError('missing', path);
  return content;
}

/** Parse one JSON edit object according to SPEC.md section 9, or null when invalid. */
function parseJsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const path = o.path;
  if (typeof path !== 'string') return null;

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(path)) throw new EditFailError('unsafe', path);
      if (tree.get(path) !== null) throw new EditFailError('exists', path);
      tree.set(path, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = requireExistingFile(tree, path);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const textLf = toLf(before);
      const oldLf = toLf(oldStr);

      let count = 0;
      for (let k = textLf.indexOf(oldLf); k >= 0; k = textLf.indexOf(oldLf, k + 1)) {
        count += 1;
      }
      if (count === 0) throw new EditFailError('no-match', path);
      if (count > 1) throw new EditFailError('ambiguous', path);

      const at = textLf.indexOf(oldLf);
      const out = textLf.slice(0, at) + toLf(newStr) + textLf.slice(at + oldLf.length);
      tree.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const insertLine = o.insert_line;
    const addLines = splitPatchLines(o.new_str);
    return (tree) => {
      const before = requireExistingFile(tree, path);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const finalBreak = before !== '' && before.endsWith(br);
      if (finalBreak) lines.pop();
      if (insertLine < 0 || insertLine > lines.length) {
        throw new EditFailError('no-match', path);
      }
      lines.splice(insertLine, 0, ...addLines);
      tree.set(path, lines.length === 0 ? '' : lines.join(br) + (finalBreak ? br : ''));
    };
  }

  return null;
}

/** Parse JSON array or JSON Lines edits according to SPEC.md section 9. */
export function parseJsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new Exit2Error('error: parse 1');

  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Exit2Error(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new Exit2Error(`error: parse ${first + 1}`);
    for (const item of parsed) {
      const edit = parseJsonEditObject(item);
      if (edit === null) throw new Exit2Error(`error: parse ${first + 1}`);
      edits.push(edit);
    }
    return edits;
  }

  lines.forEach((line, idx) => {
    if (line.trim() === '') return;
    let edit: Edit | null = null;
    try {
      edit = parseJsonEditObject(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) throw new Exit2Error(`error: parse ${idx + 1}`);
    edits.push(edit);
  });

  return edits;
}
