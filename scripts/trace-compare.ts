import { readFile, writeFile } from 'node:fs/promises';
import { diffTraces, toBaseline } from '../src/trace/compare.js';
import { createRedactor } from '../src/trace/redact.js';
import { parseTraceFile, serializeTrace, type Trace } from '../src/trace/schema.js';

// npm run scenario:compare [-- --accept] [--trace FILE] [--baseline FILE]
// Exit 0: no differences. Exit 1: differences. Exit 2: a file is missing or unusable (nothing was compared).
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1]!.startsWith('--')) {
    console.error(`${name} needs a file name.`);
    process.exit(2);
  }
  return args[i + 1]!;
};
const TRACE = flag('--trace', 'reports/trace.json');
const BASELINE = flag('--baseline', 'docs/baseline/trace.json');

async function load(file: string, hint: string): Promise<Trace> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    console.error(`${file} is missing. ${hint}`);
    process.exit(2);
  }
  try {
    return parseTraceFile(text);
  } catch (err) {
    console.error(`${file} is not a usable trace (${err instanceof Error ? err.message : String(err)}). ${hint}`);
    process.exit(2);
  }
}

let next: Trace;
try {
  next = toBaseline(await load(TRACE, 'Create it by running: npm run scenario'));
} catch (err) {
  console.error(`${TRACE} cannot be compared (${err instanceof Error ? err.message : String(err)}).`);
  process.exit(2);
}

if (args.includes('--accept')) {
  const text = serializeTrace(next);
  try {
    createRedactor().assertClean(text); // the same scan the trace was written under, so a hand-edited trace cannot become the baseline
  } catch (err) {
    console.error(`${TRACE} was not accepted: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  await writeFile(BASELINE, text);
  console.log(`baseline ${BASELINE} replaced by ${TRACE} (${next.steps.length} steps). Review the git diff before committing.`);
  process.exit(0);
}

const base = await load(BASELINE, 'Create it deliberately with: npm run scenario:compare -- --accept');
const lines = diffTraces(base, next);
if (!lines.length) {
  console.log(`no differences from ${BASELINE} (${next.steps.length} steps)`);
  process.exit(0);
}
console.log(lines.join('\n'));
console.log(`\n${lines.length} difference lines. If the change is intended: npm run scenario:compare -- --accept, then review and commit the baseline.`);
process.exit(1);
