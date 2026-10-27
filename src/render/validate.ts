import { GLYPH_RANGES } from './glyphs.js';

/** Question length limit of the image path, in characters after sanitizing (decision 0034). The REST check is Stage B. */
export const MAX_QUESTION_CHARS = 500;

/** Input longer than this is refused before any work: the 500 limit counts after sanitizing, but a megabyte of input must stay cheap. */
const MAX_RAW_CHARS = 5000;

export type QuestionError = 'empty_question' | 'question_too_long' | 'unsupported_character';
export type Validated = { ok: true; text: string } | { ok: false; code: QuestionError };

// Invisible or layout-changing characters: C0/C1 controls (not \t \n \r), soft hyphen, combining grapheme joiner, Arabic letter mark,
// Hangul and Khmer fillers, Mongolian selectors, zero-width and directional marks and overrides (200B-200F, 202A-202E, 2060-206F),
// variation selectors, BOM, interlinear annotation, tags.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E0FFF}]/gu;
const SPACES = /[\t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const MAX_MARKS = 2;

/** Combining marks need a base: a mark after nothing or after a space is dropped, and a base keeps at most MAX_MARKS (Zalgo). */
function limitMarks(s: string): string {
  let out = '';
  let marks = -1; // -1: no base yet
  for (const ch of s) {
    if (/\p{M}/u.test(ch)) {
      if (marks >= 0 && marks < MAX_MARKS) {
        out += ch;
        marks += 1;
      }
    } else {
      out += ch;
      marks = ch === ' ' || ch === '\n' ? -1 : 0;
    }
  }
  return out;
}

/** The text that will be drawn: NFC, invisible characters removed, spaces and blank lines collapsed, ends trimmed. */
export function sanitizeQuestion(raw: string): string {
  const s = limitMarks(
    raw
      .replace(/\r\n?|[\u2028\u2029]/g, '\n')
      .replace(INVISIBLE, '')
      .replace(SPACES, ' ')
      .normalize('NFC'),
  );
  return s
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hasGlyph(cp: number): boolean {
  let lo = 0;
  let hi = GLYPH_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = GLYPH_RANGES[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Sanitizes and checks a question for the image path. Fitting on the card is a measured property and is checked by `renderCard`,
 * which answers `question_too_long` as well.
 */
export function validateQuestion(raw: string): Validated {
  if (raw.length > MAX_RAW_CHARS) return { ok: false, code: 'question_too_long' };
  const text = sanitizeQuestion(raw);
  if (text === '') return { ok: false, code: 'empty_question' };
  const chars = [...text];
  if (chars.length > MAX_QUESTION_CHARS) return { ok: false, code: 'question_too_long' };
  for (const ch of chars) if (ch !== '\n' && !hasGlyph(ch.codePointAt(0)!)) return { ok: false, code: 'unsupported_character' };
  return { ok: true, text };
}
