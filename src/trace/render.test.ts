import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDocsRoutes, renderTrace } from './render.js';
import type { Trace } from './schema.js';

const trace = (over: Partial<Trace['steps'][number]>[] = [], studentRoutesEnabled = false): Trace => ({
  version: 1,
  meta: { studentRoutesEnabled },
  steps: over.map((o, i) => ({ n: i + 1, name: 'step', tableDelta: {}, events: [], ...o })),
});
const docs = parseDocsRoutes(readFileSync('docs/rest-api.md', 'utf8'));
const rest = (template: string | null, status = 200, caller = 'mcp:x', method = 'GET') => ({ seq: 1, t: 't', caller, kind: 'rest' as const, method, template, path: template ?? '/p', status, req: null, res: { a: 1 } });

describe('trace page (T-RENDER)', () => {
  it('T-RENDER-1 is self-contained: no script, no external reference, no handler attributes', () => {
    const html = renderTrace(trace([{ events: [rest('/courses')], tableDelta: { courses: 1 } }]), docs);
    expect(html).not.toMatch(/<script|<link|<iframe|<img|<object|<embed|@import|url\(/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect([...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]).every((h) => h!.startsWith('../docs/') || h!.startsWith('#'))).toBe(true);
    expect(html).toContain('<svg');
  });

  it('T-RENDER-2 shows the legend, the four boundary marks and the direct-call note near the swimlanes and in the boundary section', () => {
    const html = renderTrace(trace([{ events: [rest('/courses')] }]), docs);
    for (const id of ['B1', 'B2', 'B3', 'B4']) expect(html).toContain(`>${id}<`);
    expect(html.match(/do not use REST|call the services directly/g)!.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('Legend');
  });

  it('T-RENDER-3 recorded text cannot inject markup or script (names, paths, bodies, labels, huge and control-character strings)', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'`javascript:alert(1)\u0000‮&amp;';
    const html = renderTrace(
      trace([{ name: evil, tableDelta: { [evil]: 1 }, events: [{ ...rest(evil, 200, evil), path: evil, req: { [evil]: evil }, res: evil.repeat(5000) }, { seq: 2, t: 't', caller: evil, kind: 'click', actionId: evil, user: evil, outcome: evil }, { seq: 3, t: evil, caller: evil, kind: 'slack', origin: evil, call: 'postCard', req: evil, res: evil, error: evil }, { seq: 4, t: 't', caller: evil, kind: 'entry', origin: evil, label: evil, detail: evil }] }]),
      [{ method: 'GET', template: evil }],
    );
    expect(html).not.toMatch(/<script|<img|onerror=\s*alert\(1\)>/i);
    expect(html).not.toMatch(/[\u0000‮]/);
    expect(html).not.toContain('"\'`');
    expect(html).toContain('&#60;script&#62;');
  });

  it('T-CAT-1 the docs list 18 routes: 16 teacher routes and the 2 student routes', () => {
    expect(docs).toHaveLength(18);
    expect(docs.filter((d) => d.template.startsWith('/users/'))).toHaveLength(2);
  });

  it('T-CAT-2 student routes are "disabled by design", not a gap, when studentRoutesEnabled is false; uncalled teacher routes are flagged', () => {
    const html = renderTrace(trace([{ events: [rest('/courses'), rest('/courses', 201, 'mcp:y', 'POST'), rest('/undocumented', 200)] }]), docs);
    expect(html.match(/disabled in the scenario by design/g)).toHaveLength(2);
    expect(html).toContain('NOT CALLED by the scenario');
    expect(html).toContain('<code>GET /undocumented</code>');
    const on = renderTrace(trace([{ events: [] }], true), docs);
    expect(on).not.toContain('disabled in the scenario by design (');
  });

  it('T-CAT-3 401 and 404 answers without a route are listed apart, not as undocumented calls', () => {
    const html = renderTrace(trace([{ events: [rest(null, 401), rest(null, 404, 'scenario-rest')] }]), docs);
    expect(html).toContain('GET → 401');
    expect(html).not.toContain('<code>GET null</code>');
  });
});
