import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { CARD, layoutText, type Measure } from './layout.js';
import { validateQuestion, type QuestionError } from './validate.js';

/** Own family name: a system font called Inter must never be picked up instead. */
const FAMILY = 'RetainInter';

let registered = false;
function registerFont(): void {
  if (registered) return;
  // The font is bundled and pinned (scripts/vendor-font.ts); characters it lacks are refused by validateQuestion, so no system font is ever used.
  if (!GlobalFonts.registerFromPath(fileURLToPath(new URL('./fonts/Inter.ttf', import.meta.url)), FAMILY)) throw new Error('cannot register the bundled font');
  registered = true;
}

export interface CardImage {
  png: Buffer;
  width: number;
  height: number;
  /** The sanitized question that was drawn: use it for the `alt_text`. */
  text: string;
  fontSize: number;
  lines: number;
}

export type RenderResult = ({ ok: true } & CardImage) | { ok: false; code: QuestionError };

/** Draws the question on a white 1200x630 PNG: validate, shrink to fit, draw. The same input gives the same bytes on one machine (platform equality is not claimed). */
export function renderCard(rawQuestion: string): RenderResult {
  const v = validateQuestion(rawQuestion);
  if (!v.ok) return v;
  registerFont();
  const canvas = createCanvas(CARD.width, CARD.height);
  const ctx = canvas.getContext('2d');
  const measure: Measure = (text, size) => {
    ctx.font = `${size}px ${FAMILY}`;
    return ctx.measureText(text).width;
  };
  const layout = layoutText(v.text, measure);
  if (!layout) return { ok: false, code: 'question_too_long' };
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD.width, CARD.height);
  ctx.fillStyle = '#111111';
  ctx.font = `${layout.fontSize}px ${FAMILY}`;
  ctx.textBaseline = 'middle';
  const lineHeight = layout.fontSize * CARD.lineHeight;
  let y = (CARD.height - layout.lines.length * lineHeight) / 2 + lineHeight / 2;
  for (const line of layout.lines) {
    ctx.fillText(line, CARD.margin + 4, y); // +4: left bearings of î, ï reach 4 px left of the origin
    y += lineHeight;
  }
  return { ok: true, png: canvas.toBuffer('image/png'), width: CARD.width, height: CARD.height, text: v.text, fontSize: layout.fontSize, lines: layout.lines.length };
}
