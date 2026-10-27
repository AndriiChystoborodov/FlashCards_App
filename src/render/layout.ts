/** Geometry of the question image and the pure part of drawing it: wrapping and shrink-to-fit (decision 0034). */
export const CARD = { width: 1200, height: 630, margin: 80, maxFont: 64, minFont: 28, fontStep: 2, lineHeight: 1.3 } as const;

/** Width in pixels of `text` at `size` px; the canvas provides it, tests pass a fake. */
export type Measure = (text: string, size: number) => number;

export interface Layout {
  fontSize: number;
  lines: string[];
}

const graphemes = (s: string): string[] => [...new Intl.Segmenter().segment(s)].map((x) => x.segment);

/** Greedy word wrap; a word wider than the line is cut between characters (never inside a combining sequence). `\n` starts a paragraph. */
export function wrapLines(text: string, size: number, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let cur = '';
    for (const word of paragraph.split(' ')) {
      const joined = cur ? `${cur} ${word}` : word;
      if (measure(joined, size) <= maxWidth) {
        cur = joined;
        continue;
      }
      if (cur) lines.push(cur);
      cur = '';
      if (measure(word, size) <= maxWidth) {
        cur = word;
        continue;
      }
      for (const g of graphemes(word)) {
        if (cur && measure(cur + g, size) > maxWidth) {
          lines.push(cur);
          cur = g;
        } else cur += g;
      }
    }
    lines.push(cur);
  }
  return lines;
}

/** The largest font size (maxFont down to minFont) at which the wrapped text fits the card; null when even minFont does not fit. */
export function layoutText(text: string, measure: Measure): Layout | null {
  // Glyph ink can overhang its measured advance (stacked marks, wide capitals): 16 px of slack keeps ink inside the margin.
  const maxWidth = CARD.width - 2 * CARD.margin - 16;
  const maxHeight = CARD.height - 2 * CARD.margin;
  for (let fontSize = CARD.maxFont; fontSize >= CARD.minFont; fontSize -= CARD.fontStep) {
    const lines = wrapLines(text, fontSize, maxWidth, measure);
    if (lines.length * fontSize * CARD.lineHeight <= maxHeight) return { fontSize, lines };
  }
  return null;
}
