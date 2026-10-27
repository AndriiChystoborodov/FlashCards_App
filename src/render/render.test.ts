import { loadImage, createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openSync } from 'fontkit';
import { renderCard } from './card.js';
import { GLYPH_RANGES } from './glyphs.js';
import { glyphRangesOfFont } from './glyphRanges.js';
import { CARD, layoutText, wrapLines, type Measure } from './layout.js';
import { INVISIBLE_MIX, SAMPLES, TOO_LONG, UNSUPPORTED } from './samples.js';
import { MAX_QUESTION_CHARS, sanitizeQuestion, validateQuestion } from './validate.js';

const fakeMeasure: Measure = (t, size) => [...t].length * size * 0.5;

async function inkBox(png: Buffer) {
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (data[i]! < 250 || data[i + 1]! < 250 || data[i + 2]! < 250) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  return { width: img.width, height: img.height, minX, minY, maxX, maxY, corner: [data[0]!, data[1]!, data[2]!, data[3]!] };
}

describe('layout (R2)', () => {
  it('wraps at the width and never exceeds it, also for one very long word', () => {
    const lines = wrapLines('aaaa bbbb ' + 'c'.repeat(300), 10, 100, fakeMeasure);
    expect(lines.every((l) => fakeMeasure(l, 10) <= 100)).toBe(true);
    expect(lines.join('').replace(/ /g, '')).toBe('aaaabbbb' + 'c'.repeat(300));
  });
  it('shrinks in steps from maxFont and gives up below minFont', () => {
    expect(layoutText('Hi', fakeMeasure)!.fontSize).toBe(CARD.maxFont);
    const medium = layoutText('word '.repeat(80), fakeMeasure)!;
    expect(medium.fontSize).toBeLessThan(CARD.maxFont);
    expect(medium.fontSize).toBeGreaterThanOrEqual(CARD.minFont);
    expect(Math.abs(medium.fontSize - CARD.maxFont) % CARD.fontStep).toBe(0);
    expect(layoutText('word '.repeat(2000), fakeMeasure)).toBeNull();
  });
  it('keeps blank lines of the question', () => {
    expect(wrapLines('a\n\nb', 10, 100, fakeMeasure)).toEqual(['a', '', 'b']);
  });
});

describe('validateQuestion (R3, R4, R5)', () => {
  it('accepts the 500 limit and refuses 501 with question_too_long', () => {
    expect(validateQuestion('a'.repeat(MAX_QUESTION_CHARS)).ok).toBe(true);
    expect(validateQuestion('a'.repeat(MAX_QUESTION_CHARS + 1))).toEqual({ ok: false, code: 'question_too_long' });
    expect(validateQuestion(TOO_LONG)).toEqual({ ok: false, code: 'question_too_long' });
  });
  it('counts characters, not UTF-16 units, and not stripped characters', () => {
    expect(validateQuestion('ї'.repeat(MAX_QUESTION_CHARS)).ok).toBe(true);
    expect(validateQuestion('a' + '\u200B'.repeat(4000) + 'b')).toEqual({ ok: true, text: 'ab' });
  });
  it('strips controls, zero-width and bidi characters and collapses whitespace', () => {
    const v = validateQuestion(INVISIBLE_MIX);
    expect(v).toEqual({ ok: true, text: 'Zerowidth bidi and control chars and spaces collapse\n\nend' });
  });
  it('removes combining marks without a base and limits them per base', () => {
    expect(sanitizeQuestion('\u0301\u0301 a\u0301\u0301\u0301\u0301b')).toBe('a\u0301\u0301\u0301b'.normalize('NFC')); // NFC folds the first mark into a; two more marks stay
    expect(validateQuestion('\u0301\u0301')).toEqual({ ok: false, code: 'empty_question' });
    expect(validateQuestion(' \u200D\u200B ')).toEqual({ ok: false, code: 'empty_question' });
  });
  it('refuses private-use glyphs and a huge input at once', () => {
    expect(validateQuestion('a\uE000b')).toEqual({ ok: false, code: 'unsupported_character' });
    expect(validateQuestion('a'.repeat(10_000_000))).toEqual({ ok: false, code: 'question_too_long' });
  });
  it('accepts Cyrillic, Ukrainian and umlauts', () => {
    for (const q of [SAMPLES.russian, SAMPLES.ukrainian, SAMPLES.umlauts, 'ї є і ґ ä ö ü ß Ä Ö Ü']) expect(validateQuestion(q).ok).toBe(true);
  });
  it('refuses characters the font lacks with unsupported_character', () => {
    for (const q of UNSUPPORTED) expect(validateQuestion(q)).toEqual({ ok: false, code: 'unsupported_character' });
    expect(validateQuestion('שלום')).toEqual({ ok: false, code: 'unsupported_character' }); // right-to-left
  });
});

describe('glyph list (R6)', () => {
  it('matches the cmap of the vendored font', () => {
    const font = fileURLToPath(new URL('./fonts/Inter.ttf', import.meta.url));
    expect(GLYPH_RANGES).toEqual(glyphRangesOfFont(font));
    const cps = new Set(openSync(font).characterSet);
    for (const cp of [0x44f, 0x457, 0x454, 0x456, 0x491, 0xe4, 0xdf]) expect(cps.has(cp)).toBe(true);
  });
});

describe('renderCard (R1, R7)', () => {
  it('draws a 1200x630 PNG with a white background and is byte-identical on a second run', async () => {
    const a = renderCard(SAMPLES.short);
    const b = renderCard(SAMPLES.short);
    if (!a.ok || !b.ok) throw new Error('render failed');
    expect(a.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(a.png.equals(b.png)).toBe(true);
    const box = await inkBox(a.png);
    expect([box.width, box.height]).toEqual([CARD.width, CARD.height]);
    expect(box.corner).toEqual([255, 255, 255, 255]);
    expect(box.maxX).toBeGreaterThan(box.minX); // some text was drawn
  });
  it('shrinks the font for the long sample and keeps the short one big', () => {
    const short = renderCard(SAMPLES.short);
    const long = renderCard(SAMPLES.long);
    if (!short.ok || !long.ok) throw new Error('render failed');
    expect(short.fontSize).toBe(CARD.maxFont);
    expect(long.fontSize).toBeLessThan(short.fontSize);
    expect(long.fontSize).toBeGreaterThanOrEqual(CARD.minFont);
  });
  it('returns the codes instead of drawing', () => {
    expect(renderCard(TOO_LONG)).toEqual({ ok: false, code: 'question_too_long' });
    expect(renderCard(UNSUPPORTED[0])).toEqual({ ok: false, code: 'unsupported_character' });
    expect(renderCard('')).toEqual({ ok: false, code: 'empty_question' });
    // 500 wide characters pass the length rule but cannot fit the card
    expect(renderCard('W'.repeat(MAX_QUESTION_CHARS))).toEqual({ ok: false, code: 'question_too_long' });
  });
  it('keeps all ink inside the margins, also for hostile input', async () => {
    const hostile = [
      ...Object.values(SAMPLES),
      INVISIBLE_MIX,
      'Ш'.repeat(60) + ' ' + 'W'.repeat(40), // one very long word
      'A\u0301\u0301\u0301\u0301\u0301\u0301 ' + 'ẞ\u0308'.repeat(40), // many combining marks
      '\u0301\u0301\u0301 hello',
      'a\n\n\n\n\n\n\nb' + ' '.repeat(2000) + 'c',
      'i'.repeat(400),
      'j'.repeat(400),
      '\u00EE\u00EF '.repeat(80),
    ];
    for (const q of hostile) {
      const r = renderCard(q);
      if (!r.ok) continue;
      const box = await inkBox(r.png);
      expect(box.minX, q.slice(0, 20)).toBeGreaterThanOrEqual(CARD.margin - 2);
      expect(box.maxX, q.slice(0, 20)).toBeLessThanOrEqual(CARD.width - CARD.margin + 2);
      expect(box.minY, q.slice(0, 20)).toBeGreaterThanOrEqual(CARD.margin - 2);
      expect(box.maxY, q.slice(0, 20)).toBeLessThanOrEqual(CARD.height - CARD.margin + 2);
    }
  });
  it('renders every sample (R8)', () => {
    for (const [name, q] of Object.entries(SAMPLES)) expect(renderCard(q).ok, name).toBe(true);
  });
});
