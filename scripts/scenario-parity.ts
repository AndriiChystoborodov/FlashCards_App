import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { parseTraceFile } from '../src/trace/schema.js';

// npm run scenario:parity: runs the scenario twice (recorder off, then on) and compares the `ok` lines and the table deltas of every step.
// Wipes retain_dev twice, like `npm run scenario`.
const run = (trace: 'off' | 'on') => {
  const r = spawnSync('npx', ['tsx', 'scripts/scenario.ts'], { env: { ...process.env, SCENARIO_TRACE: trace }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`scenario with the recorder ${trace} failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`.slice(0, 4000));
  return r.stdout.split('\n').filter((l) => /^(ok|pending|\d+ ok)/.test(l));
};
const off = run('off');
const offDeltas = JSON.parse(await readFile('reports/trace-off-steps.json', 'utf8')) as { name: string; delta: Record<string, number> }[];
const on = run('on');
const onTrace = parseTraceFile(await readFile('reports/trace.json', 'utf8'));
assert.deepEqual(on, off, 'the ok/pending lines differ between recorder off and on');
assert.deepEqual(onTrace.steps.map((s) => ({ name: s.name, delta: s.tableDelta })), offDeltas, 'the table deltas differ between recorder off and on');
console.log(`parity ok: ${on.length} result lines and ${offDeltas.length} table deltas are identical with the recorder off and on`);
