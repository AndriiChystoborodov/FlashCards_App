import { openSync } from 'fontkit';

/** Controls and C1 are never drawn; the sanitizer removes or converts them before the glyph check. */
const isControl = (cp: number) => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
/** Private-use code points hold icon and feature glyphs in Inter: they look like nothing and ink leaves the margins. */
const isPrivateUse = (cp: number) => (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000;

/** Inclusive ranges of the code points a font file has glyphs for (dev only: fontkit is a devDependency). */
export function glyphRangesOfFont(path: string): [number, number][] {
  const cps = [...new Set(openSync(path).characterSet)].filter((cp) => !isControl(cp) && !isPrivateUse(cp)).sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const cp of cps) {
    const last = ranges.at(-1);
    if (last && cp === last[1] + 1) last[1] = cp;
    else ranges.push([cp, cp]);
  }
  return ranges;
}
