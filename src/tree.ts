import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MoveRecord, ParsedFileLines, TreeInterface } from './types.ts';

/** Check whether a relative path is safe according to SPEC.md section 3. */
export function isSafePath(path: string): boolean {
  return (
    path !== '' &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
  );
}

/** Parse a file's text into lines, detected EOL, and whether it ends with a line break. */
export function parseFileLines(text: string): ParsedFileLines {
  if (text === '') {
    return { lines: [], eol: '\n', endsWithBreak: false };
  }
  const firstNl = text.indexOf('\n');
  const eol: '\n' | '\r\n' = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(eol);
  const endsWithBreak = text.endsWith(eol);
  if (endsWithBreak) lines.pop();
  return { lines, eol, endsWithBreak };
}

/** Serialize file lines back to text using the specified EOL and trailing break rule. */
export function serializeFileLines(lines: string[], eol: '\n' | '\r\n', endsWithBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(eol) + (endsWithBreak ? eol : '');
}

/** Virtual in-memory tree of files supporting rollback and atomic commit. */
export class VirtualTree implements TreeInterface {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: MoveRecord[] = [];

  original(path: string): string | null {
    if (!this.orig.has(path)) {
      let value: string | null = null;
      try {
        if (statSync(path).isFile()) {
          value = readFileSync(path, 'utf8');
        }
      } catch {
        value = null;
      }
      this.orig.set(path, value);
    }
    return this.orig.get(path)!;
  }

  get(path: string): string | null {
    return this.now.has(path) ? this.now.get(path)! : this.original(path);
  }

  set(path: string, content: string | null): void {
    this.now.set(path, content);
  }

  recordMove(oldPath: string, newPath: string): void {
    this.moves.push({ oldPath, newPath });
  }

  snapshot(): { now: Map<string, string | null>; movesLen: number } {
    return { now: new Map(this.now), movesLen: this.moves.length };
  }

  restore(snap: { now: Map<string, string | null>; movesLen: number }): void {
    this.now.clear();
    for (const [k, v] of snap.now) {
      this.now.set(k, v);
    }
    this.moves.length = snap.movesLen;
  }

  /** Commit changes (unless checkOnly) and return formatted output lines for exit 0. */
  commit(checkOnly: boolean): string[] {
    const added = new Set<string>();
    const deleted = new Set<string>();
    const modified = new Set<string>();

    for (const [p, current] of this.now) {
      const was = this.original(p);
      if (was === current) continue;
      if (was === null && current !== null) added.add(p);
      else if (was !== null && current === null) deleted.add(p);
      else modified.add(p);
    }

    const rows: Array<{ sortKey: string; line: string }> = [];

    for (const move of this.moves) {
      if (deleted.has(move.oldPath) && added.has(move.newPath)) {
        deleted.delete(move.oldPath);
        added.delete(move.newPath);
        rows.push({ sortKey: move.newPath, line: `R ${move.oldPath} -> ${move.newPath}` });
      }
    }

    for (const p of added) rows.push({ sortKey: p, line: `A ${p}` });
    for (const p of deleted) rows.push({ sortKey: p, line: `D ${p}` });
    for (const p of modified) rows.push({ sortKey: p, line: `M ${p}` });

    rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')));

    if (!checkOnly) {
      for (const [p, current] of this.now) {
        if (this.original(p) !== current && current === null) {
          rmSync(p, { force: true });
        }
      }
      for (const [p, current] of this.now) {
        if (this.original(p) !== current && current !== null) {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, current);
        }
      }
    }

    const lines = rows.map((r) => r.line);
    lines.push(`ok: ${lines.length} ${lines.length === 1 ? 'file' : 'files'}`);
    return lines;
  }
}
