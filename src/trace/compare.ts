import type { Trace, TraceEvent } from './schema.js';

/** The structure of a JSON value: keys and types, no values. Arrays are described by their first element. */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error('a body is nested more than 64 levels deep');
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  return typeof v; // string, number, boolean
}

/** The committed baseline: REST bodies reduced to their shape, `seq` zeroed, everything else (status, caller, Slack text, table deltas) as recorded. */
export function toBaseline(t: Trace): Trace {
  return {
    ...t,
    meta: { ...t.meta, baseline: true },
    steps: t.steps.map((s) => ({
      ...s,
      events: s.events.map((e): TraceEvent => (e.kind === 'rest' ? { ...e, seq: 0, req: shapeOf(e.req), res: shapeOf(e.res) } : { ...e, seq: 0 })),
    })),
  };
}

const sig = (e: TraceEvent): string => {
  switch (e.kind) {
    case 'rest':
      return `rest ${e.method} ${e.template ?? '(no route)'} by ${e.caller}`;
    case 'slack':
      return `slack ${e.call} (from ${e.origin})`;
    case 'click':
      return `click ${e.actionId}`;
    case 'entry':
      return `entry ${e.label} (${e.caller})`;
  }
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Paths where two shapes differ: `+key`, `-key`, or a changed type. */
function shapeDiff(a: unknown, b: unknown, at = ''): string[] {
  if (same(a, b)) return [];
  const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (obj(a) && obj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => (!(k in a) ? [`+${at}${k}`] : !(k in b) ? [`-${at}${k}`] : shapeDiff(a[k], b[k], `${at}${k}.`)));
  }
  if (Array.isArray(a) && Array.isArray(b)) return shapeDiff(a[0] ?? 'null', b[0] ?? 'null', `${at}[].`);
  return [`${at.replace(/\.$/, '') || '(root)'}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`];
}

function describeChange(a: TraceEvent, b: TraceEvent): string[] {
  const out: string[] = [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'seq');
  for (const k of keys) {
    const x: unknown = (a as Record<string, unknown>)[k];
    const y: unknown = (b as Record<string, unknown>)[k];
    if (same(x, y)) continue;
    if (k === 'req' || k === 'res') {
      const d = shapeDiff(x, y);
      out.push(`${k} shape: ${d.slice(0, 8).join(', ')}${d.length > 8 ? `, ... ${d.length - 8} more` : ''}`);
    } else out.push(`${k}: ${JSON.stringify(x)?.slice(0, 120)} -> ${JSON.stringify(y)?.slice(0, 120)}`);
  }
  return out;
}

/** Pairs two event lists by signature: the common start and end first, then a longest common subsequence of the middle (by position when the middle is too large for that). */
function align(a: TraceEvent[], b: TraceEvent[]): [number | null, number | null][] {
  const sa = a.map(sig);
  const sb = b.map(sig);
  const out: [number | null, number | null][] = [];
  let lo = 0;
  while (lo < sa.length && lo < sb.length && sa[lo] === sb[lo]) out.push([lo, lo++]);
  let ea = sa.length;
  let eb = sb.length;
  const tail: [number, number][] = [];
  while (ea > lo && eb > lo && sa[ea - 1] === sb[eb - 1]) tail.push([--ea, --eb]);
  const n = ea - lo;
  const m = eb - lo;
  if (n * m > 4_000_000) {
    // shortcut: positional pairing, when a step changed so much that an exact alignment is not worth its memory; upgrade if a real step ever gets this large.
    for (let k = 0; k < Math.max(n, m); k++) out.push([k < n ? lo + k : null, k < m ? lo + k : null]);
  } else {
    const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i]![j] = sa[lo + i] === sb[lo + j] ? len[i + 1]![j + 1]! + 1 : Math.max(len[i + 1]![j]!, len[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && sa[lo + i] === sb[lo + j]) out.push([lo + i++, lo + j++]);
      else if (j < m && (i >= n || len[i]![j + 1]! >= len[i + 1]![j]!)) out.push([null, lo + j++]);
      else out.push([lo + i++, null]);
    }
  }
  return out.concat(tail.reverse());
}

const MAX_LINES = 300;
const deltaText = (d: Record<string, number>) => Object.entries(d).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ') || 'none';

/** Differences between two baseline-shaped traces, as lines for the terminal. Empty means no difference. */
export function diffTraces(base: Trace, next: Trace): string[] {
  const lines: string[] = [];
  if (base.meta.studentRoutesEnabled !== next.meta.studentRoutesEnabled) lines.push(`meta: studentRoutesEnabled ${base.meta.studentRoutesEnabled} -> ${next.meta.studentRoutesEnabled}`);
  const nextByName = new Map(next.steps.map((s) => [s.name, s]));
  const baseNames = new Set(base.steps.map((s) => s.name));
  for (const s of base.steps) {
    const t = nextByName.get(s.name);
    if (!t) {
      lines.push(`step ${s.n} "${s.name}": REMOVED (${s.events.length} events)`);
      continue;
    }
    const head = `step ${t.n} "${s.name}"`;
    if (s.n !== t.n) lines.push(`${head}: moved from position ${s.n} to ${t.n}`);
    const inStep: string[] = [];
    for (const [i, j] of align(s.events, t.events)) {
      if (i === null) inStep.push(`  + added   ${sig(t.events[j!]!)}${t.events[j!]!.kind === 'rest' ? ` -> ${(t.events[j!] as Extract<TraceEvent, { kind: 'rest' }>).status}` : ''}`);
      else if (j === null) inStep.push(`  - removed ${sig(s.events[i]!)}`);
      else {
        const a = s.events[i]!;
        const b = t.events[j]!;
        if (!same({ ...a, seq: 0 }, { ...b, seq: 0 })) inStep.push(`  ~ changed ${sig(a)}`, ...describeChange(a, b).map((x) => `      ${x}`));
      }
    }
    if (!same(s.tableDelta, t.tableDelta)) {
      const keys = [...new Set([...Object.keys(s.tableDelta), ...Object.keys(t.tableDelta)])].sort();
      for (const k of keys) if (s.tableDelta[k] !== t.tableDelta[k]) inStep.push(`  ~ table ${k}: ${s.tableDelta[k] ?? 0} -> ${t.tableDelta[k] ?? 0} rows`);
    }
    if (inStep.length) lines.push(`${head}:`, ...inStep);
  }
  for (const t of next.steps) if (!baseNames.has(t.name)) lines.push(`step ${t.n} "${t.name}": ADDED (${t.events.length} events, rows ${deltaText(t.tableDelta)})`);
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `... ${lines.length - MAX_LINES} more difference lines not shown`] : lines;
}
