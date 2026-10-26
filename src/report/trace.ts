import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rating = z.enum(['hard', 'medium', 'easy']).nullable();

/** What the scenario script records for reports/scenario.json (docs/scenario.md, decision 0030). */
export const traceSchema = z.object({
  title: z.string(),
  timezone: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  simulatedThrough: date,
  cards: z.array(z.object({ name: z.string(), assessment: z.boolean() })),
  students: z.array(z.object({ name: z.string(), status: z.string(), progress: z.number(), learned: z.number().nullable() })),
  days: z.array(
    z.object({
      date,
      sent: z.array(z.string()),
      answered: z.array(z.object({ card: z.string(), rating, correct: z.boolean(), due: z.string(), clamped: z.boolean() })),
      learned: z.array(z.string()),
      introduced: z.array(z.string()),
      introducedTotal: z.number(),
      learnedTotal: z.number(),
    }),
  ),
});
export type ScenarioTrace = z.infer<typeof traceSchema>;

export function parseTrace(text: string): ScenarioTrace {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  const r = traceSchema.safeParse(json);
  if (!r.success) throw new Error(`unexpected shape (${r.error.issues[0]?.path.join('.') || 'root'}: ${r.error.issues[0]?.message})`);
  return r.data;
}

export interface TraceInput {
  title: string;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  /** Every card of the course in position order, with the dates the database holds for the traced student. */
  cards: { name: string; assessment: boolean; introducedAt: Date | null; learnedAt: Date | null }[];
  /** One entry per real answer of the traced student, recorded where the scenario submitted it. */
  answers: { card: string; sentAt: Date; answeredAt: Date; rating: 'hard' | 'medium' | 'easy' | null; correct: boolean; due: Date; clamped: boolean }[];
  students: ScenarioTrace['students'];
}

export function buildTrace(input: TraceInput): ScenarioTrace {
  const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: input.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const dates: string[] = [];
  const last = dayOf(input.endsAt);
  for (let d = new Date(`${dayOf(input.startsAt)}T12:00:00Z`); d.toISOString().slice(0, 10) <= last; d = new Date(d.getTime() + 86_400_000)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  if (!dates.length) throw new Error('the course ends before it starts');
  let introducedTotal = 0;
  let learnedTotal = 0;
  const days = dates.map((date) => {
    const introduced = input.cards.filter((c) => c.introducedAt && dayOf(c.introducedAt) === date).map((c) => c.name);
    const learned = input.cards.filter((c) => c.learnedAt && dayOf(c.learnedAt) === date).map((c) => c.name);
    introducedTotal += introduced.length;
    learnedTotal += learned.length;
    return {
      date,
      sent: [...new Set(input.answers.filter((a) => dayOf(a.sentAt) === date).map((a) => a.card))],
      answered: input.answers
        .filter((a) => dayOf(a.answeredAt) === date)
        .map((a) => ({ card: a.card, rating: a.rating, correct: a.correct, due: a.due.toISOString(), clamped: a.clamped })),
      learned,
      introduced,
      introducedTotal,
      learnedTotal,
    };
  });
  return {
    title: input.title,
    timezone: input.timezone,
    startsAt: input.startsAt.toISOString(),
    endsAt: input.endsAt.toISOString(),
    simulatedThrough: [...days].reverse().find((d) => d.answered.length || d.sent.length)?.date ?? dates.at(-1)!, // last day with activity, not the wall clock
    cards: input.cards.map((c) => ({ name: c.name, assessment: c.assessment })),
    students: input.students,
    days,
  };
}
