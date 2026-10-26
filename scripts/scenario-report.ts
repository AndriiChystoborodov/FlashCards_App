import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renderReport } from '../src/report/render.js';
import { parseTrace } from '../src/report/trace.js';

// Renders reports/scenario.json (written by `npm run scenario`) to a self-contained reports/scenario.html.
const IN = 'reports/scenario.json';
const OUT = 'reports/scenario.html';

let raw: string;
try {
  raw = await readFile(IN, 'utf8');
} catch {
  console.error(`${IN} is missing. Create it by running: npm run scenario`);
  process.exit(1);
}
try {
  await mkdir('reports', { recursive: true });
  await writeFile(OUT, renderReport(parseTrace(raw)));
} catch (err) {
  console.error(`${IN} is malformed (${err instanceof Error ? err.message : String(err)}). Recreate it by running: npm run scenario`);
  process.exit(1);
}
console.log(`report written to ${OUT}`);
