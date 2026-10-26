import { describe, expect, it } from 'vitest';
import { diffTraces, shapeOf, toBaseline } from './compare.js';
import { parseTraceFile, serializeTrace, type Trace } from './schema.js';

const rest = (n: number, over: Record<string, unknown> = {}) => ({ seq: n, t: 't', caller: 'mcp:a', kind: 'rest' as const, method: 'GET', template: '/courses', path: '/courses', status: 200, req: null, res: { courses: [{ id: 'course-1', title: 'T' }] }, ...over });
const base = (): Trace => ({ version: 1, meta: { studentRoutesEnabled: false }, steps: [{ n: 1, name: 'a', tableDelta: { courses: 1 }, events: [rest(1), rest(2, { method: 'POST' })] }, { n: 2, name: 'b', tableDelta: {}, events: [] }] });
const diff = (mutate: (t: Trace) => void) => {
  const next = structuredClone(base());
  mutate(next);
  return diffTraces(toBaseline(base()), toBaseline(next));
};

describe('compare (T-CMP)', () => {
  it('T-CMP-1 identical traces, and ids or seq numbers that differ, give no differences', () => {
    expect(diff(() => {})).toEqual([]);
    expect(diff((t) => void ((t.steps[0]!.events[0] as { seq: number; res: unknown }).seq = 99))).toEqual([]);
    expect(diff((t) => void ((t.steps[0]!.events[0] as { res: unknown }).res = { courses: [{ id: 'course-7', title: 'other value' }] }))).toEqual([]); // values are not part of the baseline
  });

  it('T-CMP-2 a changed status, a body shape change, an added and a removed call are each reported', () => {
    expect(diff((t) => void ((t.steps[0]!.events[0] as { status: number }).status = 404)).join('\n')).toMatch(/changed rest GET \/courses[\s\S]*status: 200 -> 404/);
    expect(diff((t) => void ((t.steps[0]!.events[0] as { res: unknown }).res = { courses: [{ id: 'x', extra: 1 }] })).join('\n')).toMatch(/res shape: .*\+courses\.\[\]\.extra/);
    expect(diff((t) => t.steps[0]!.events.push(rest(3, { method: 'DELETE', template: '/x' }) as never)).join('\n')).toMatch(/\+ added   rest DELETE \/x/);
    expect(diff((t) => void t.steps[0]!.events.pop()).join('\n')).toMatch(/- removed rest POST \/courses/);
  });

  it('T-CMP-3 table deltas and whole steps are compared', () => {
    expect(diff((t) => void (t.steps[0]!.tableDelta = { courses: 2, users: 1 })).join('\n')).toMatch(/table courses: 1 -> 2[\s\S]*table users: 0 -> 1/);
    expect(diff((t) => void t.steps.pop()).join('\n')).toMatch(/step 2 "b": REMOVED/);
    expect(diff((t) => t.steps.push({ n: 3, name: 'c', tableDelta: {}, events: [] })).join('\n')).toMatch(/step 3 "c": ADDED/);
  });

  it('T-CMP-4 the baseline file round-trips and garbage or truncated files are refused', () => {
    const text = serializeTrace(toBaseline(base()));
    expect(parseTraceFile(text)).toEqual(toBaseline(base()));
    expect(() => parseTraceFile(text.slice(0, text.length - 30))).toThrow(/not valid JSON/);
    expect(() => parseTraceFile('')).toThrow();
    expect(() => parseTraceFile('{"version":2}')).toThrow(/unexpected shape/);
    expect(() => parseTraceFile('[1,2]')).toThrow(/unexpected shape/);
    expect(() => parseTraceFile(JSON.stringify({ version: 1, meta: {}, steps: [] }))).toThrow(/unexpected shape/);
    expect(() => parseTraceFile(text.replace('"kind":"rest"', '"kind":"nope"'))).toThrow(/unexpected shape/);
  });

  it('T-CMP-5 shapeOf describes keys and types only', () => {
    expect(shapeOf({ a: [1, 2], b: null, c: { d: 'x' }, e: [] })).toEqual({ a: ['number'], b: 'null', c: { d: 'string' }, e: [] });
  });

  it('T-CMP-6 duplicate step names, negative numbers and absurd statuses are refused; deep bodies and huge steps do not hang', () => {
    const t = base();
    t.steps.push({ ...t.steps[0]! });
    expect(() => parseTraceFile(JSON.stringify(t))).toThrow(/unexpected shape/);
    const neg = base();
    (neg.steps[0]!.events[0] as { status: number }).status = -3;
    expect(() => parseTraceFile(JSON.stringify(neg))).toThrow(/unexpected shape/);
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = { a: deep };
    expect(() => shapeOf(deep)).toThrow(/nested/);
    const big = (n: number, tag: string): Trace => ({ version: 1, meta: { studentRoutesEnabled: false }, steps: [{ n: 1, name: 's', tableDelta: {}, events: Array.from({ length: n }, (_, i) => rest(i, { template: `/${tag}/${i}` }) as never) }] });
    const t0 = Date.now();
    expect(diffTraces(toBaseline(big(5000, 'a')), toBaseline(big(5000, 'a')))).toEqual([]);
    expect(diffTraces(toBaseline(big(5000, 'a')), toBaseline(big(5000, 'b'))).length).toBeLessThanOrEqual(301);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
