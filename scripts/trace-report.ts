import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRedactor } from '../src/trace/redact.js';
import { assertPageClean } from '../src/trace/files.js';
import { parseTraceFile } from '../src/trace/schema.js';
import { parseDocsRoutes, renderTrace } from '../src/trace/render.js';

// Renders reports/trace.json (written by `npm run scenario`) to a self-contained reports/trace.html.
const IN = 'reports/trace.json';
const OUT = 'reports/trace.html';

let raw: string;
try {
  raw = await readFile(IN, 'utf8');
} catch {
  console.error(`${IN} is missing. Create it by running: npm run scenario`);
  process.exit(1);
}
try {
  const docs = parseDocsRoutes(await readFile('docs/rest-api.md', 'utf8'));
  await mkdir('reports', { recursive: true });
  const html = renderTrace(parseTraceFile(raw), docs);
  assertPageClean(createRedactor(), html); // the page is scanned like the trace: nothing is written when it holds secret-looking text
  await writeFile(OUT, html);
} catch (err) {
  console.error(`${IN} cannot be rendered (${err instanceof Error ? err.message : String(err)}). Recreate it by running: npm run scenario`);
  process.exit(1);
}
console.log(`trace page written to ${OUT}`);
