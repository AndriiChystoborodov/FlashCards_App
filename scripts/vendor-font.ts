/**
 * Downloads the vendored font (decision 0034) from google/fonts at a pinned commit and refuses any file whose sha256 differs
 * from the recorded one. `npm run font:vendor` writes src/render/fonts/, `npm run font:vendor -- --check` only verifies the
 * committed files. The files are committed: this script is needed only to re-vendor or to prove the files are the pinned ones.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const COMMIT = 'a4c0b21f839d7ac65a7d8b49eb81bddd110774a3';
const FILES = [
  { path: 'ofl/inter/Inter[opsz,wght].ttf', name: 'Inter.ttf', sha256: '29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031' },
  { path: 'ofl/inter/OFL.txt', name: 'OFL.txt', sha256: '5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57' },
];
const dir = new URL('../src/render/fonts/', import.meta.url);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const check = process.argv.includes('--check');

let failed = false;
mkdirSync(dir, { recursive: true });
for (const f of FILES) {
  let bytes: Uint8Array;
  if (check) {
    bytes = readFileSync(new URL(f.name, dir));
  } else {
    const url = `https://raw.githubusercontent.com/google/fonts/${COMMIT}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download of ${f.name} failed: HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  const actual = sha(bytes);
  if (actual !== f.sha256) {
    failed = true;
    console.error(`MISMATCH ${f.name}: expected ${f.sha256}, got ${actual}`);
    continue; // never written
  }
  if (!check) writeFileSync(new URL(f.name, dir), bytes);
  console.log(`ok ${f.name} ${bytes.length} bytes sha256=${actual}`);
}
if (failed) process.exit(1);
