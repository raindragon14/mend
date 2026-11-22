// main.ts is mend, the CLI SPEC.md specifies, implementing unified diffs, SEARCH/REPLACE blocks,
// V4A patches, and JSON edits with three-tier line matching and atomic writes.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { writeSync } from 'node:fs';
import { parseArgs, readPatchText, splitPatchLines } from './src/cli.ts';
import { detectFormat } from './src/detect.ts';
import { parseJsonEdits } from './src/json.ts';
import { parseSearchReplaceEdits } from './src/search-replace.ts';
import { VirtualTree } from './src/tree.ts';
import { EditFailError, Exit2Error } from './src/types.ts';
import type { Edit, FormatName } from './src/types.ts';
import { parseUnifiedEdits } from './src/unified.ts';
import { parseV4AEdits } from './src/v4a.ts';

function parseEdits(kind: FormatName, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return parseJsonEdits(text, lines);
  if (kind === 'unified') return parseUnifiedEdits(lines, strict);
  if (kind === 'search-replace') return parseSearchReplaceEdits(lines, strict);
  return parseV4AEdits(lines, strict);
}

function applyEdits(edits: Edit[], tree: VirtualTree): EditFailError[] {
  const fails: EditFailError[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (err) {
      if (!(err instanceof EditFailError)) throw err;
      tree.restore(snap);
      fails.push(err);
    }
  }
  return fails;
}

function run(args: string[]): { code: number; out: string[] } {
  const options = parseArgs(args);
  if (options === null) {
    return { code: 2, out: ['error: usage'] };
  }

  let text: string;
  try {
    text = readPatchText(options.patchFile);
  } catch (err) {
    if (err instanceof Exit2Error) return { code: 2, out: [err.line] };
    throw err;
  }

  const lines = splitPatchLines(text);
  const kind = options.format === 'auto' ? detectFormat(lines) : options.format;
  if (kind === null) {
    return { code: 2, out: ['error: format'] };
  }

  let edits: Edit[];
  try {
    edits = parseEdits(kind, text, lines, options.strict);
    if (edits.length === 0) throw new Exit2Error('error: parse 1');
  } catch (err) {
    if (err instanceof Exit2Error) return { code: 2, out: [err.line] };
    throw err;
  }

  const tree = new VirtualTree();
  const fails = applyEdits(edits, tree);

  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }

  return { code: 0, out: tree.commit(options.check) };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
