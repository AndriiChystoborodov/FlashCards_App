// fontkit ships no types; only what scripts/gen-glyphs.ts and the glyph test use.
declare module 'fontkit' {
  export function openSync(path: string): { characterSet: number[] };
}
