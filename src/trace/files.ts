import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Redactor } from './redact.js';
import { serializeTrace, type Trace } from './schema.js';

/** Serialises, runs the fail-closed scan, then writes. A hit throws and leaves the old file alone. */
export async function writeTrace(file: string, trace: Trace, redactor: Redactor): Promise<void> {
  const text = serializeTrace(trace);
  redactor.assertClean(text);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** Every file under `dir`, recursively, that contains one of `needles` (case-insensitive). Returns file names only, never the match. */
export async function filesContaining(dir: string, needles: string[]): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const text = (await readFile(p, 'utf8')).toLowerCase();
        if (needles.some((n) => n && text.includes(n.toLowerCase()))) hits.push(p);
      }
    }
  };
  await walk(dir);
  return hits;
}

/** The fail-closed scan for a rendered page: entities are decoded and our own doc links dropped first, so the scan sees what a reader sees. */
export function assertPageClean(redactor: Redactor, html: string): void {
  redactor.assertClean(html.replace(/href="\.\.\/docs\/[^"]*"/g, '').replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))));
}
