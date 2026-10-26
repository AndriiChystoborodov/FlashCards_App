import { describe, expect, it } from 'vitest';
import { renderReport } from './render.js';
import { buildTrace, parseTrace, type TraceInput } from './trace.js';

const input = (over: Partial<TraceInput> = {}): TraceInput => ({
  title: 'Security basics',
  timezone: 'Europe/Zurich',
  startsAt: new Date('2026-01-05T09:00:00Z'),
  endsAt: new Date('2026-01-07T22:59:00Z'),
  cards: [
    { name: 'A1', assessment: true, introducedAt: new Date('2026-01-05T09:00:00Z'), learnedAt: new Date('2026-01-05T13:05:00Z') },
    { name: 'card-1', assessment: false, introducedAt: new Date('2026-01-05T13:05:00Z'), learnedAt: null },
  ],
  answers: [
    { card: 'A1', sentAt: new Date('2026-01-05T09:00:00Z'), answeredAt: new Date('2026-01-05T13:00:00Z'), rating: 'easy', correct: true, due: new Date('2026-01-13T13:00:00Z'), clamped: false },
    { card: 'card-1', sentAt: new Date('2026-01-05T13:05:00Z'), answeredAt: new Date('2026-01-05T13:06:00Z'), rating: null, correct: false, due: new Date('2026-01-06T13:06:00Z'), clamped: true },
  ],
  students: [
    { name: 'Ann', status: 'completed', progress: 40, learned: 4 },
    { name: 'Bea', status: 'exempt', progress: 100, learned: null },
  ],
  ...over,
});

describe('buildTrace', () => {
  it('lists every local day of the course and totals introduced and learned cards', () => {
    const t = buildTrace(input());
    expect(t.days.map((d) => d.date)).toEqual(['2026-01-05', '2026-01-06', '2026-01-07']);
    expect(t.simulatedThrough).toBe('2026-01-05');
    expect(t.days[0]).toMatchObject({ sent: ['A1', 'card-1'], learned: ['A1'], introducedTotal: 2, learnedTotal: 1 });
    expect(t.days[0]!.answered.map((a) => [a.card, a.rating, a.correct, a.clamped])).toEqual([['A1', 'easy', true, false], ['card-1', null, false, true]]);
    expect(t.days[2]).toMatchObject({ sent: [], answered: [], introducedTotal: 2, learnedTotal: 1 });
  });

  it('rejects a course that ends before it starts', () => {
    expect(() => buildTrace(input({ endsAt: new Date('2026-01-01T00:00:00Z') }))).toThrow('ends before it starts');
  });

  it('assigns an event just before local midnight to its local day, not the UTC day', () => {
    const t = buildTrace(input({ answers: [{ card: 'A1', sentAt: new Date('2026-01-05T22:30:00Z'), answeredAt: new Date('2026-01-05T22:45:00Z'), rating: 'easy', correct: true, due: new Date('2026-01-13T00:00:00Z'), clamped: false }] }));
    expect(t.days.find((d) => d.sent.includes('A1'))!.date).toBe('2026-01-05');
    expect(t.days.find((d) => d.answered.length)!.date).toBe('2026-01-05');
    const next = buildTrace(input({ answers: [{ card: 'A1', sentAt: new Date('2026-01-05T23:30:00Z'), answeredAt: new Date('2026-01-05T23:40:00Z'), rating: 'easy', correct: true, due: new Date('2026-01-13T00:00:00Z'), clamped: false }] }));
    expect(next.days.find((d) => d.answered.length)!.date).toBe('2026-01-06');
  });
});

describe('parseTrace', () => {
  it('round-trips a built trace', () => {
    const t = buildTrace(input());
    expect(parseTrace(JSON.stringify(t))).toEqual(t);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseTrace('{nope')).toThrow('not valid JSON');
  });

  it('rejects JSON of the wrong shape and names the field', () => {
    expect(() => parseTrace(JSON.stringify({ title: 'x' }))).toThrow(/unexpected shape \(timezone/);
  });
});

describe('renderReport', () => {
  const html = renderReport(buildTrace(input()));

  it('is self-contained: no script, no external reference, only the SVG namespace URL', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\b(href|src)=/i);
    expect([...html.matchAll(/https?:\/\/[^"'\s<]+/g)].map((m) => m[0]).filter((u) => u !== 'http://www.w3.org/2000/svg')).toEqual([]);
  });

  it('shows the title, run date from the trace, time zone, outcome and the exempt student', () => {
    expect(html).toContain('<title>Security basics scenario report</title>');
    expect(html).toContain('Run date 2026-01-05 (simulated). Time zone Europe/Zurich.');
    expect(html).toContain('Ann learned 4 of 2 cards (40%)');
    expect(html).toContain('Bea is exempt after the assessment (score 100%) and gets no further cards.');
  });

  it('marks answers by letter and shape: Easy, wrong, clamped, learned', () => {
    expect(html).toContain('>E</text>');
    expect(html).toContain('>X</text>');
    expect(html).toContain('>C</text>');
    expect(html).toContain('>L</text>');
  });

  it('escapes text coming from the trace', () => {
    const evil = renderReport(buildTrace(input({ title: '<script>alert(1)</script>&"', cards: [{ name: '<b>x</b>', assessment: false, introducedAt: null, learnedAt: null }], answers: [] })));
    expect(evil).not.toContain('<script>alert');
    expect(evil).not.toContain('<b>x</b>');
    expect(evil).toContain('&#60;script&#62;alert(1)&#60;/script&#62;&#38;&#34;');
  });

  it('says so when nobody is exempt', () => {
    const none = renderReport(buildTrace(input({ students: [{ name: 'Ann', status: 'completed', progress: 40, learned: 4 }] })));
    expect(none).toContain('No exempt student in this run.');
  });
});
