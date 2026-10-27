/** `npm run render:samples`: draws the fixed sample questions into reports/samples/ (gitignored) for a visual check. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderCard } from '../src/render/card.js';
import { INVISIBLE_MIX, SAMPLES, TOO_LONG, UNSUPPORTED } from '../src/render/samples.js';

const dir = new URL('../reports/samples/', import.meta.url);
mkdirSync(dir, { recursive: true });
const inputs: [string, string][] = [
  ...Object.entries(SAMPLES),
  ['invisible', INVISIBLE_MIX],
  ...UNSUPPORTED.map((s, i): [string, string] => [`unsupported${i + 1}`, s]),
  ['too_long', TOO_LONG],
];
for (const [name, question] of inputs) {
  const t0 = performance.now();
  const r = renderCard(question);
  const ms = (performance.now() - t0).toFixed(0);
  if (!r.ok) {
    console.log(`${name.padEnd(13)} refused: ${r.code}`);
    continue;
  }
  writeFileSync(new URL(`${name}.png`, dir), r.png);
  console.log(`${name.padEnd(13)} reports/samples/${name}.png ${r.png.length} bytes ${r.width}x${r.height} font ${r.fontSize}px ${r.lines} lines ${ms} ms`);
}
