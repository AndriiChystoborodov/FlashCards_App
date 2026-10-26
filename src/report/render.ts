import type { ScenarioTrace } from './trace.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const LABEL_W = 190;
const COL_W = 84;
const ROW_H = 46;
const HEAD_H = 62;
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const INK = '#000';

const dayLabel = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  return { wd: new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(d), n: String(d.getUTCDate()) };
};
const fmtDateTime = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

const text = (x: number, y: number, s: string, size = 20, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" font-family="Helvetica, Arial, sans-serif" ${extra.includes('fill=') ? '' : `fill="${INK}" `}${extra}>${esc(s)}</text>`;

/** One cell of the timeline. Marks differ by shape and letter, never by colour alone. */
function cell(t: ScenarioTrace, card: string, di: number, introducedDay: number, learnedDay: number, x: number, y: number): string {
  const day = t.days[di]!;
  const cx = x + COL_W / 2;
  const cy = y + ROW_H / 2;
  const out: string[] = [];
  const answers = day.answered.filter((a) => a.card === card);
  const learnedBefore = learnedDay >= 0 && di > learnedDay;
  if (learnedBefore) out.push(`<rect x="${x}" y="${y}" width="${COL_W}" height="${ROW_H}" fill="#e0e0e0"/>`);
  if (day.sent.includes(card)) out.push(`<polygon points="${x + 6},${cy - 9} ${x + 6},${cy + 9} ${x + 18},${cy}" fill="${INK}"/>`);
  const a = answers.at(-1);
  if (a) {
    if (a.correct && a.rating) {
      const fill = a.rating === 'easy' ? INK : a.rating === 'medium' ? '#bbb' : '#fff';
      const ink = a.rating === 'easy' ? '#fff' : INK;
      out.push(`<circle cx="${cx}" cy="${cy}" r="16" fill="${fill}" stroke="${INK}" stroke-width="3"/>`);
      out.push(text(cx, cy + 7, a.rating[0]!.toUpperCase(), 21, `text-anchor="middle" font-weight="bold" fill="${ink}"`));
    } else {
      out.push(`<polygon points="${cx},${cy - 19} ${cx + 19},${cy} ${cx},${cy + 19} ${cx - 19},${cy}" fill="#fff" stroke="${INK}" stroke-width="3"/>`);
      out.push(text(cx, cy + 7, 'X', 21, 'text-anchor="middle" font-weight="bold"'));
    }
    if (answers.length > 1) out.push(text(x + COL_W - 6, y + ROW_H - 6, `×${answers.length}`, 13, 'text-anchor="end"'));
    if (answers.some((c) => c.clamped)) {
      out.push(`<rect x="${x + COL_W - 20}" y="${y + 3}" width="17" height="17" fill="${INK}"/>`);
      out.push(text(x + COL_W - 11.5, y + 16.5, 'C', 14, 'text-anchor="middle" font-weight="bold" fill="#fff"'));
    }
  } else if (di >= introducedDay && introducedDay >= 0 && !learnedBefore && !(learnedDay === di)) {
    out.push(`<line x1="${x + 24}" y1="${cy}" x2="${x + COL_W - 10}" y2="${cy}" stroke="${INK}" stroke-width="3" stroke-dasharray="7 6"/>`);
  }
  if (learnedDay === di) {
    out.push(`<rect x="${x + 2}" y="${y + 2}" width="${COL_W - 4}" height="${ROW_H - 4}" fill="none" stroke="${INK}" stroke-width="5"/>`);
    out.push(`<rect x="${x + COL_W - 22}" y="${y + ROW_H - 22}" width="19" height="19" fill="${INK}"/>`);
    out.push(text(x + COL_W - 12.5, y + ROW_H - 7, 'L', 15, 'text-anchor="middle" font-weight="bold" fill="#fff"'));
  }
  return out.join('');
}

function timeline(t: ScenarioTrace): string {
  const n = t.days.length;
  const w = LABEL_W + n * COL_W;
  const gridH = t.cards.length * ROW_H;
  const h = HEAD_H + gridH + 2 * 40 + 10;
  const parts: string[] = [`<svg ${SVG_NS} viewBox="0 0 ${w + 10} ${h}" role="img" aria-labelledby="tl-t"><title id="tl-t">Timeline: one row per card, one column per day</title>`];
  t.days.forEach((d, i) => {
    const { wd, n: dn } = dayLabel(d.date);
    const x = LABEL_W + i * COL_W;
    parts.push(text(x + COL_W / 2, 26, wd, 20, 'text-anchor="middle"'));
    parts.push(text(x + COL_W / 2, 52, dn, 26, 'text-anchor="middle" font-weight="bold"'));
  });
  t.cards.forEach((c, r) => {
    const y = HEAD_H + r * ROW_H;
    const introducedDay = t.days.findIndex((d) => d.introduced.includes(c.name));
    const learnedDay = t.days.findIndex((d) => d.learned.includes(c.name));
    parts.push(`<rect x="0" y="${y}" width="${w}" height="${ROW_H}" fill="${r % 2 ? '#f4f4f4' : '#fff'}"/>`);
    parts.push(text(8, y + 31, c.assessment ? `${c.name}  assessment` : c.name, 21, 'font-weight="bold"'));
    t.days.forEach((_, di) => parts.push(cell(t, c.name, di, introducedDay, learnedDay, LABEL_W + di * COL_W, y)));
  });
  for (let i = 0; i <= n; i++) parts.push(`<line x1="${LABEL_W + i * COL_W}" y1="${HEAD_H}" x2="${LABEL_W + i * COL_W}" y2="${HEAD_H + gridH}" stroke="#777" stroke-width="1"/>`);
  parts.push(`<line x1="${LABEL_W + n * COL_W}" y1="${HEAD_H - 8}" x2="${LABEL_W + n * COL_W}" y2="${HEAD_H + gridH}" stroke="${INK}" stroke-width="5"/>`);
  parts.push(`<line x1="0" y1="${HEAD_H}" x2="${w}" y2="${HEAD_H}" stroke="${INK}" stroke-width="3"/>`);
  const rows: [string, (d: ScenarioTrace['days'][number]) => number][] = [
    ['asked that day', (d) => d.sent.length],
    ['learned so far', (d) => d.learnedTotal],
  ];
  rows.forEach(([label, fn], k) => {
    const y = HEAD_H + gridH + 12 + k * 40;
    parts.push(text(8, y + 26, label, 20, 'font-weight="bold"'));
    t.days.forEach((d, i) => parts.push(text(LABEL_W + i * COL_W + COL_W / 2, y + 26, String(fn(d)), 24, 'text-anchor="middle"')));
  });
  parts.push('</svg>');
  return parts.join('');
}

function legend(): string {
  const item = (x: number, glyph: string, label: string) => `<g transform="translate(${x} 0)">${glyph}</g>${text(x + 50, 33, label, 19)}`;
  const g = [
    item(0, `<polygon points="10,15 10,33 22,24" fill="${INK}"/>`, 'sent'),
    item(150, `<circle cx="22" cy="24" r="16" fill="#fff" stroke="${INK}" stroke-width="3"/>${text(22, 31, 'H', 21, 'text-anchor="middle" font-weight="bold"')}`, 'right, Hard'),
    item(330, `<circle cx="22" cy="24" r="16" fill="#bbb" stroke="${INK}" stroke-width="3"/>${text(22, 31, 'M', 21, 'text-anchor="middle" font-weight="bold"')}`, 'right, Medium'),
    item(540, `<circle cx="22" cy="24" r="16" fill="${INK}" stroke="${INK}" stroke-width="3"/>${text(22, 31, 'E', 21, 'text-anchor="middle" font-weight="bold" fill="#fff"')}`, 'right, Easy'),
    item(710, `<polygon points="22,5 41,24 22,43 3,24" fill="#fff" stroke="${INK}" stroke-width="3"/>${text(22, 31, 'X', 21, 'text-anchor="middle" font-weight="bold"')}`, 'wrong or "Don\'t know"'),
  ];
  const g2 = [
    item(0, `<line x1="2" y1="24" x2="40" y2="24" stroke="${INK}" stroke-width="3" stroke-dasharray="7 6"/>`, 'waiting (introduced, not due)'),
    item(400, `<rect x="4" y="6" width="36" height="36" fill="${INK}"/>${text(22, 33, 'C', 22, 'text-anchor="middle" font-weight="bold" fill="#fff"')}`, 'next due clamped to the day before the course ends'),
  ];
  const g3 = [
    item(0, `<rect x="5" y="9" width="32" height="30" fill="none" stroke="${INK}" stroke-width="5"/>${text(30, 34, 'L', 15, 'text-anchor="middle" font-weight="bold"')}`, 'learned that day (grey afterwards)'),
    item(400, `<line x1="22" y1="4" x2="22" y2="44" stroke="${INK}" stroke-width="5"/>`, 'thick line: the end of the course'),
  ];
  const row = (parts: string[], y: number) => `<g transform="translate(0 ${y})">${parts.join('')}</g>`;
  return `<svg ${SVG_NS} viewBox="0 0 1100 160" role="img" aria-labelledby="lg-t"><title id="lg-t">Legend</title>${row(g, 0)}${row(g2, 50)}${row(g3, 100)}</svg>`;
}

function chart(t: ScenarioTrace): string {
  const n = t.days.length;
  const top = 40;
  const unit = 20;
  const total = t.cards.length;
  const base = top + total * unit;
  const w = LABEL_W + n * COL_W;
  const finalLearned = t.days.at(-1)?.learnedTotal ?? 0;
  const pct = total ? Math.round((finalLearned / total) * 100) : 0;
  const p: string[] = [`<svg ${SVG_NS} viewBox="0 0 ${w + 10} ${base + 74}" role="img" aria-labelledby="ch-t"><title id="ch-t">Cards introduced and learned per day</title>`];
  p.push(`<line x1="${LABEL_W}" y1="${base - total * unit}" x2="${w}" y2="${base - total * unit}" stroke="#777" stroke-width="2" stroke-dasharray="3 5"/>`);
  p.push(text(LABEL_W - 10, base - total * unit + 7, `${total}`, 20, 'text-anchor="end"'));
  p.push(text(LABEL_W - 10, base + 7, '0', 20, 'text-anchor="end"'));
  p.push(`<line x1="${LABEL_W}" y1="${base}" x2="${w}" y2="${base}" stroke="${INK}" stroke-width="3"/>`);
  const yTarget = base - finalLearned * unit;
  p.push(`<line x1="${LABEL_W}" y1="${yTarget}" x2="${w}" y2="${yTarget}" stroke="${INK}" stroke-width="4"/>`);
  p.push(text(LABEL_W + 4 * COL_W, yTarget - 10, `outcome ${pct}%: ${finalLearned} of ${total} learned`, 20, 'font-weight="bold"'));
  t.days.forEach((d, i) => {
    const cx = LABEL_W + i * COL_W + COL_W / 2;
    const hi = d.introduced.length * unit;
    const hl = d.learned.length * unit;
    p.push(`<rect x="${cx - 32}" y="${base - hi}" width="28" height="${hi}" fill="${INK}"/>`);
    p.push(`<rect x="${cx + 4}" y="${base - hl}" width="28" height="${hl}" fill="#fff" stroke="${INK}" stroke-width="3"/>`);
    if (hi) p.push(text(cx - 18, base - hi - 6, String(d.introduced.length), 18, 'text-anchor="middle"'));
    if (hl) p.push(text(cx + 18, base - hl - 8, String(d.learned.length), 18, 'text-anchor="middle"'));
    const { wd, n: dn } = dayLabel(d.date);
    p.push(text(cx, base + 28, `${wd} ${dn}`, 18, 'text-anchor="middle"'));
  });
  const pts = t.days.map((d, i) => `${LABEL_W + i * COL_W + COL_W / 2},${base - d.learnedTotal * unit}`);
  p.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${INK}" stroke-width="3" stroke-dasharray="9 5"/>`);
  pts.forEach((pt) => p.push(`<circle cx="${pt.split(',')[0]}" cy="${pt.split(',')[1]}" r="5" fill="${INK}"/>`));
  p.push(`<rect x="0" y="${base + 44}" width="22" height="22" fill="${INK}"/>${text(30, base + 62, 'introduced that day', 19)}`);
  p.push(`<rect x="290" y="${base + 44}" width="22" height="22" fill="#fff" stroke="${INK}" stroke-width="3"/>${text(320, base + 62, 'learned that day', 19)}`);
  p.push(`<line x1="560" y1="${base + 55}" x2="600" y2="${base + 55}" stroke="${INK}" stroke-width="3" stroke-dasharray="9 5"/><circle cx="580" cy="${base + 55}" r="5" fill="${INK}"/>${text(610, base + 62, 'learned so far', 19)}`);
  p.push('</svg>');
  return p.join('');
}

export function renderReport(t: ScenarioTrace): string {
  const ann = t.students.find((s) => s.learned !== null);
  const exempt = t.students.filter((s) => s.status === 'exempt');
  const sub = `Run date ${t.simulatedThrough} (simulated). Time zone ${t.timezone}. Course ${fmtDateTime(t.startsAt, t.timezone)} to ${fmtDateTime(t.endsAt, t.timezone)}.`;
  const note = exempt.length
    ? exempt.map((s) => `${esc(s.name)} is exempt after the assessment (score ${s.progress}%) and gets no further cards.`).join(' ')
    : 'No exempt student in this run.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.title)} scenario report</title>
<style>body{margin:0;padding:24px 28px;background:#fff;color:#000;font-family:Helvetica,Arial,sans-serif;font-size:22px;line-height:1.35}h1{font-size:36px;margin:0 0 6px}h2{font-size:28px;margin:30px 0 8px}p{margin:6px 0}.sub{font-size:22px}.note{border:4px solid #000;padding:10px 14px;margin:18px 0;font-size:24px;font-weight:bold}svg{display:block;width:100%;max-width:1280px;height:auto}</style>
</head><body>
<h1>${esc(t.title)}: ${ann ? esc(ann.name) : 'student'} learned ${ann?.learned ?? 0} of ${t.cards.length} cards (${ann?.progress ?? 0}%)</h1>
<p class="sub">${esc(sub)}</p>
<h2>Each card, each day</h2>
${timeline(t)}
${legend()}
<h2>Cards introduced and learned per day</h2>
${chart(t)}
<p class="note">${note}</p>
</body></html>
`;
}
