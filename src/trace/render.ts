import { BOUNDARIES, DIRECT_CALL_NOTE, boundaryOf, type Boundary } from './boundaries.js';
import type { Trace, TraceEvent } from './schema.js';

// reports/trace.html: one self-contained file, inline SVG and HTML, no script, no external request. Every recorded text goes through `esc`.
// The input is already redacted (redact.ts); the renderer still escapes everything, because a trace file is data and could be edited.

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
export const esc = (s: unknown): string => String(s ?? '').replace(CONTROL, '·').replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface DocsRoute {
  method: string;
  template: string;
}

/** Routes listed in docs/rest-api.md: every backticked `METHOD /path` (the tables and the student routes). */
export function parseDocsRoutes(md: string): DocsRoute[] {
  const seen = new Map<string, DocsRoute>();
  for (const m of md.matchAll(/`(GET|POST|PATCH|DELETE) (\/[^`\s]*)`/g)) seen.set(`${m[1]} ${m[2]}`, { method: m[1]!, template: m[2]! });
  return [...seen.values()];
}

const LANES = ['Teacher / MCP client', 'REST API', 'Services', 'Slack handler', 'Tick', 'Slack adapter', 'Postgres'];
const LANE_W = 168;
const X0 = 90;
const ROW = 50;
const laneX = (i: number) => X0 + i * LANE_W;
const W = X0 + LANES.length * LANE_W - 40;
const FONT = 'Helvetica, Arial, sans-serif';

const shapeMark = (id: Boundary['id'], cx: number, cy: number): string => {
  const base = 'fill="#fff" stroke="#000" stroke-width="3"';
  const shape =
    id === 'B1' ? `<rect x="${cx - 14}" y="${cy - 14}" width="28" height="28" ${base}/>`
    : id === 'B2' ? `<polygon points="${cx},${cy - 17} ${cx + 17},${cy + 13} ${cx - 17},${cy + 13}" ${base}/>`
    : id === 'B3' ? `<polygon points="${cx},${cy - 17} ${cx + 17},${cy} ${cx},${cy + 17} ${cx - 17},${cy}" ${base}/>`
    : `<polygon points="${cx - 9},${cy - 15} ${cx + 9},${cy - 15} ${cx + 18},${cy} ${cx + 9},${cy + 15} ${cx - 9},${cy + 15} ${cx - 18},${cy}" ${base}/>`;
  return `${shape}<text x="${cx}" y="${cy + 5}" font-size="13" font-weight="bold" text-anchor="middle" font-family="${FONT}" fill="#000">${id}</text>`;
};

interface Arrow {
  from: number;
  to: number;
  label: string;
  boundary: Boundary['id'] | null;
  dashed: boolean;
}

function arrowOf(e: TraceEvent): Arrow {
  switch (e.kind) {
    case 'rest':
      return { from: 0, to: 1, label: `${e.method} ${e.template ?? e.path} → ${e.status}`, boundary: boundaryOf(e), dashed: false };
    case 'slack':
      return { from: 2, to: 5, label: `${e.call}${typeof (e.req as { text?: unknown } | null)?.text === 'string' ? ` "${clip(((e.req as { text: string }).text).replace(/\s+/g, ' '), 46)}"` : ''}${e.error ? ` FAILED (${e.error})` : ''}`, boundary: null, dashed: false };
    case 'click':
      return { from: 5, to: 3, label: `click ${e.actionId} → ${e.outcome}`, boundary: boundaryOf(e), dashed: false };
    case 'entry':
      return e.origin === 'tick'
        ? { from: 4, to: 2, label: e.label, boundary: boundaryOf(e), dashed: false }
        : { from: 3, to: 2, label: `${e.label} (direct call, no handler)`, boundary: null, dashed: true }; // the scenario answers without a click
  }
}

function swimlane(arrows: Arrow[], tableDelta: Record<string, number>): string {
  const all = [...arrows];
  const rows = Object.entries(tableDelta).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length) all.push({ from: 2, to: 6, label: `rows: ${rows.map(([t, d]) => `${t} ${d > 0 ? '+' : ''}${d}`).join(', ')}`, boundary: 'B1', dashed: false });
  const H = 56 + Math.max(all.length, 1) * ROW + 10;
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Sequence of the calls in this step">`];
  LANES.forEach((l, i) => {
    out.push(`<line x1="${laneX(i)}" y1="46" x2="${laneX(i)}" y2="${H}" stroke="#000" stroke-width="2" stroke-dasharray="3 7"/>`);
    out.push(`<text x="${laneX(i)}" y="30" font-size="17" font-weight="bold" text-anchor="middle" font-family="${FONT}" fill="#000">${esc(l)}</text>`);
  });
  all.forEach((a, i) => {
    const y = 56 + i * ROW + ROW / 2;
    const x1 = laneX(a.from);
    const x2 = laneX(a.to);
    const dir = x2 > x1 ? 1 : -1;
    out.push(`<line x1="${x1}" y1="${y}" x2="${x2 - dir * 4}" y2="${y}" stroke="#000" stroke-width="3"${a.dashed ? ' stroke-dasharray="9 6"' : ''}/>`);
    out.push(`<polygon points="${x2},${y} ${x2 - dir * 14},${y - 8} ${x2 - dir * 14},${y + 8}" fill="#000"/>`);
    const lx = Math.min(x1, x2) + (a.boundary ? 50 : 12); // the mark sits at the left end, the label after it
    out.push(`<text x="${lx}" y="${y - 9}" font-size="17" font-family="${FONT}" fill="#000">${esc(`${i + 1}. ${clip(a.label, 78)}`)}</text>`);
    if (a.boundary) out.push(shapeMark(a.boundary, Math.min(x1, x2) + 28, y - 1));
  });
  out.push('</svg>');
  return out.join('');
}

const pre = (v: unknown) => {
  const text = v === null || v === undefined ? '(none)' : typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? '(none)');
  return `<pre>${esc(text.length > 20_000 ? `${text.slice(0, 20_000)}… [cut: ${text.length} characters]` : text)}</pre>`;
};

function detail(e: TraceEvent, i: number): string {
  const a = arrowOf(e);
  const body =
    e.kind === 'rest' ? `<b>caller</b> ${esc(e.caller)}<br><b>path</b> ${esc(e.path)}<br><b>request</b>${pre(e.req)}<b>response</b>${pre(e.res)}`
    : e.kind === 'slack' ? `<b>caused by</b> ${esc(e.origin)} (${esc(e.caller)})<br><b>request</b>${pre(e.req)}<b>response</b>${pre(e.res)}`
    : e.kind === 'click' ? `<b>user</b> ${esc(e.user)}<br><b>action</b> ${esc(e.actionId)}<br><b>outcome</b> ${esc(e.outcome)}`
    : `<b>caller</b> ${esc(e.caller)}<br><b>detail</b>${pre(e.detail)}`;
  return `<details><summary>${i + 1}. ${esc(clip(a.label, 120))}${a.boundary ? ` [${a.boundary}]` : ''}</summary><div class="body">${body}</div></details>`;
}

function catalog(trace: Trace, docs: DocsRoute[]): string {
  const calls = new Map<string, { n: number; statuses: Set<number>; callers: Set<string> }>();
  const unrouted = new Map<string, number>();
  for (const s of trace.steps) {
    for (const e of s.events) {
      if (e.kind !== 'rest') continue;
      if (e.template === null) {
        const k = `${e.method} → ${e.status}`;
        unrouted.set(k, (unrouted.get(k) ?? 0) + 1);
        continue;
      }
      const k = `${e.method} ${e.template}`;
      const c = calls.get(k) ?? { n: 0, statuses: new Set<number>(), callers: new Set<string>() };
      c.n += 1;
      c.statuses.add(e.status);
      c.callers.add(e.caller.replace(/^mcp:.*/, 'mcp'));
      calls.set(k, c);
    }
  }
  const docKeys = new Set(docs.map((d) => `${d.method} ${d.template}`));
  const student = (d: DocsRoute) => d.template.startsWith('/users/');
  const rows = docs.map((d) => {
    const c = calls.get(`${d.method} ${d.template}`);
    const state = c
      ? `<td>called ${c.n}×</td><td>${esc([...c.statuses].sort().join(', '))}</td><td>${esc([...c.callers].sort().join(', '))}</td>`
      : student(d) && !trace.meta.studentRoutesEnabled
        ? '<td colspan="3">◇ disabled in the scenario by design (studentRoutesEnabled: false, <a href="../docs/decisions/0018-student-routes-dev-only.md">decision 0018</a>)</td>'
        : '<td colspan="3">✖ NOT CALLED by the scenario</td>';
    return `<tr><td><code>${esc(d.method)} ${esc(d.template)}</code></td>${state}</tr>`;
  });
  const extra = [...calls.entries()].filter(([k]) => !docKeys.has(k));
  const nCalled = docs.filter((d) => calls.has(`${d.method} ${d.template}`)).length;
  return `
<p>Routes are matched by <b>method + path template</b> (Express's route path, e.g. <code>/courses/:courseId</code>) against every backticked <code>METHOD /path</code> in <a href="../docs/rest-api.md">docs/rest-api.md</a>. ${docs.length} routes in the docs, ${nCalled} called, ${docs.filter((d) => student(d) && !trace.meta.studentRoutesEnabled).length} disabled by design.</p>
<table><tr><th>Route in the docs</th><th>Scenario</th><th>Statuses</th><th>Callers</th></tr>${rows.join('')}</table>
<h3>Called but not in the docs</h3>${extra.length ? `<table><tr><th>Route</th><th>Calls</th></tr>${extra.map(([k, c]) => `<tr><td><code>${esc(k)}</code></td><td>${c.n}</td></tr>`).join('')}</table>` : '<p>None.</p>'}
<h3>Answered without a matching route</h3>${unrouted.size ? `<table><tr><th>Request</th><th>Count</th></tr>${[...unrouted].map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td></tr>`).join('')}</table><p>401 for a missing or wrong token and 404 for an unknown path; no route is reached, so there is no template.</p>` : '<p>None.</p>'}`;
}

function boundaries(trace: Trace): string {
  const counts = new Map<string, number>();
  for (const s of trace.steps) {
    for (const e of s.events) {
      const b = boundaryOf(e);
      if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    if (Object.keys(s.tableDelta).length) counts.set('B1', (counts.get('B1') ?? 0) + 1);
  }
  return `<table><tr><th>Mark</th><th>Boundary</th><th>Arrow</th><th>Arrows</th><th>What would change in the current code</th></tr>${BOUNDARIES.map(
    (b) => `<tr><td><svg width="44" height="40" viewBox="0 0 44 40" role="img" aria-label="${b.id}">${shapeMark(b.id, 22, 20)}</svg></td><td><b>${b.id}</b> ${esc(b.name)}</td><td>${esc(b.arrow)}</td><td>${counts.get(b.id) ?? 0}</td><td>${esc(b.change)} ${b.docs.map((d) => `<a href="${d.href}">${esc(d.label)}</a>`).join(', ')}</td></tr>`,
  ).join('')}</table>
<p><b>No mark:</b> Services to Slack adapter is already a network call today (the Slack Web API), and the REST API to Services hop stays inside one process.</p>
<p class="note"><b>Decision for the cloud refactoring.</b> ${esc(DIRECT_CALL_NOTE)}</p>`;
}

export function renderTrace(trace: Trace, docs: DocsRoute[]): string {
  const stepHtml = trace.steps
    .map((s) => {
      const arrows = s.events.map(arrowOf);
      return `<details class="step" open><summary><b>${s.n}.</b> ${esc(clip(s.name, 200))} <span class="n">(${s.events.length} calls)</span></summary>${swimlane(arrows, s.tableDelta)}<div class="list">${s.events.map(detail).join('')}</div></details>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Retain API trace</title>
<style>
body{font:20px/1.45 ${FONT};color:#000;background:#fff;margin:0 auto;max-width:1300px;padding:16px 24px}
h1{font-size:34px}h2{font-size:28px;border-bottom:4px solid #000;padding-top:18px}h3{font-size:22px}
table{border-collapse:collapse;width:100%;margin:10px 0}th,td{border:2px solid #000;padding:6px 10px;text-align:left;vertical-align:top}th{background:#e0e0e0}
code,pre{font-family:Menlo,Consolas,monospace;font-size:16px}pre{background:#f2f2f2;border:1px solid #000;padding:8px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:4px 0}
.note{border:4px solid #000;padding:10px 14px;background:#f2f2f2}.step{border:3px solid #000;margin:14px 0;padding:8px 12px}.step>summary{font-size:22px;cursor:pointer}.n{font-weight:normal;font-size:17px}
.list details{margin:4px 0 4px 8px}.list summary{cursor:pointer;font-size:17px}.body{padding:4px 14px}a{color:#000}
</style></head><body>
<h1>Retain API trace</h1>
<p>Recorded while <code>npm run scenario</code> ran. ${trace.steps.length} steps. Every id, email, name, Slack id and token is replaced by a stable alias (<code>student-1</code>, <code>U-1</code>, <code>course-1</code>). Full requests and responses are under each arrow. Events are shown in the order they were recorded (array order within a step); <code>seq</code> only numbers them in <code>reports/trace.json</code> and is zeroed in the committed baseline, which <code>npm run scenario:compare</code> compares by array order.</p>
<p class="note"><b>Synthetic data only.</b> This trace and the baseline are built from the scenario's made-up students; real student data must never be traced. <code>reports/</code> is git-ignored.</p>
<h2>Legend</h2>
<table><tr><th>Mark</th><th>Meaning</th></tr>
<tr><td>solid arrow</td><td>a recorded call</td></tr>
<tr><td>dashed arrow</td><td>the scenario enters the services directly in place of a Slack click (no handler runs)</td></tr>
${BOUNDARIES.map((b) => `<tr><td><svg width="44" height="40" viewBox="0 0 44 40" role="img" aria-label="${b.id}">${shapeMark(b.id, 22, 20)}</svg></td><td><b>${b.id}</b> would be a network boundary in a cloud deployment: ${esc(b.name)} (${esc(b.arrow)})</td></tr>`).join('')}
</table>
<p class="note"><b>Handlers and the tick do not use REST.</b> ${esc(DIRECT_CALL_NOTE)}</p>
<h2>A. Calls per scenario step</h2>${stepHtml}
<h2>B. Endpoint catalog</h2>${catalog(trace, docs)}
<h2>C. Network boundaries</h2>${boundaries(trace)}
<p>Recorded by wrappers around the REST app, the Slack port, the action router and the services entry points; table counts are read from Postgres before and after each step. The wrappers record; they do not change what the scenario asserts.</p>
</body></html>
`;
}
