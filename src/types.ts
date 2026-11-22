export type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json';
export type FormatOption = 'auto' | FormatName;

export type FailCode = 'no-match' | 'ambiguous' | 'missing' | 'exists' | 'unsafe';

export class Exit2Error extends Error {
  readonly line: string;

  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

export class EditFailError extends Error {
  readonly code: FailCode;
  readonly path: string;

  constructor(code: FailCode, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

export interface CliOptions {
  format: FormatOption;
  check: boolean;
  strict: boolean;
  patchFile: string | null;
}

export interface ParsedFileLines {
  lines: string[];
  eol: '\n' | '\r\n';
  endsWithBreak: boolean;
}

export interface MoveRecord {
  oldPath: string;
  newPath: string;
}

export interface TreeInterface {
  get(path: string): string | null;
  set(path: string, content: string | null): void;
  recordMove(oldPath: string, newPath: string): void;
}

export type Edit = (tree: TreeInterface) => void;
