import { z } from 'zod';

const json = z.unknown();
const base = { seq: z.number().int().nonnegative(), t: z.string(), caller: z.string() };

/** One REST call, recorded by the server-side middleware. `template` is Express's route path, null when no route matched (401, 404). */
const rest = z.object({ ...base, kind: z.literal('rest'), method: z.string(), template: z.string().nullable(), path: z.string(), status: z.number().int().min(100).max(599), req: json, res: json });
/** A call through the SlackPort. `origin` says which entry point caused it. */
const slack = z.object({ ...base, kind: z.literal('slack'), origin: z.string(), call: z.enum(['postCard', 'replaceMessage', 'lookupEmail']), req: json, res: json, error: z.string().optional() });
/** A Bolt action handler run. */
const click = z.object({ ...base, kind: z.literal('click'), actionId: z.string(), user: z.string(), outcome: z.string() });
/** An in-process entry into the services (the tick, a student answer) that is not a REST call. */
const entry = z.object({ ...base, kind: z.literal('entry'), origin: z.string(), label: z.string(), detail: json.optional() });

export const eventSchema = z.discriminatedUnion('kind', [rest, slack, click, entry]);
export type TraceEvent = z.infer<typeof eventSchema>;

export const traceSchema = z.object({
  version: z.literal(1),
  /** What the run was configured with; the viewer needs `studentRoutesEnabled` to tell "disabled by design" from "never called". */
  meta: z.object({ studentRoutesEnabled: z.boolean(), baseline: z.boolean().optional() }),
  steps: z.array(z.object({ n: z.number().int().nonnegative(), name: z.string(), tableDelta: z.record(z.string(), z.number()), events: z.array(eventSchema) })).refine((steps) => new Set(steps.map((s) => s.name)).size === steps.length, 'step names must be unique'),
});
export type Trace = z.infer<typeof traceSchema>;

/** One event per line keeps `git diff` of the baseline readable. */
export function serializeTrace(t: Trace): string {
  const steps = t.steps.map((s) => {
    const events = s.events.map((e) => `    ${JSON.stringify(e)}`).join(',\n');
    return `  {\n   "n": ${s.n},\n   "name": ${JSON.stringify(s.name)},\n   "tableDelta": ${JSON.stringify(s.tableDelta)},\n   "events": [${events ? `\n${events}\n   ` : ''}]\n  }`;
  });
  return `{\n "version": 1,\n "meta": ${JSON.stringify(t.meta)},\n "steps": [\n${steps.join(',\n')}\n ]\n}\n`;
}

export function parseTraceFile(text: string): Trace {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  const r = traceSchema.safeParse(value);
  if (!r.success) throw new Error(`unexpected shape (${r.error.issues[0]?.path.join('.') || 'root'}: ${r.error.issues[0]?.message})`);
  return r.data;
}
