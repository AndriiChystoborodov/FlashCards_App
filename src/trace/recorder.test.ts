import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { harness, courseBody, cardBody } from '../api/harness.js';
import { createApp } from '../api/app.js';
import { listen } from '../api/testClient.js';
import { createControlledClock } from '../clock.js';
import { db } from '../db/testDb.js';
import { REJECT_TEXT, ERROR_TEXT, buildRatingMessage, buildCardMessage } from '../slack/card.js';
import { FakeSlack } from '../slack/fake.js';
import type { ClickArgs } from '../slack/handlers.js';
import { assertPageClean, filesContaining, writeTrace } from './files.js';
import { CALLER_HEADER, createRecorder } from './recorder.js';
import { renderTrace } from './render.js';
import { parseTraceFile, serializeTrace } from './schema.js';
import { shapeOf } from './compare.js';

const clock = () => createControlledClock(new Date('2026-01-05T09:00:00Z'));

async function appWith(recorder: ReturnType<typeof createRecorder> | undefined) {
  const h = await harness();
  const api = await listen({ ...h.deps, removedRetentionDays: 14, studentRoutesEnabled: false, bindHost: '127.0.0.1', ...(recorder && { recorder }) });
  return { h, api };
}

describe('recorder (T-REC)', () => {
  it('T-REC-1 records template, caller, status and bodies of a request, with ids and emails as aliases', async () => {
    const rec = createRecorder({ clock: clock() });
    const { h, api } = await appWith(rec);
    const token = await h.teacher();
    rec.beginStep(1, 'one');
    const r = await api.call(token, 'POST', '/courses', courseBody(), { [CALLER_HEADER]: 'mcp:create_course' });
    await api.call(token, 'GET', `/courses/${r.body.course_id}`, undefined, { [CALLER_HEADER]: 'scenario-rest' });
    await api.call(null, 'GET', '/courses', undefined, { [CALLER_HEADER]: 'bad caller; drop' });
    const t = rec.trace({ studentRoutesEnabled: false });
    const [post, get, anon] = t.steps[0]!.events;
    expect(post).toMatchObject({ kind: 'rest', caller: 'mcp:create_course', method: 'POST', template: '/courses', path: '/courses', status: 201 });
    expect(get).toMatchObject({ caller: 'scenario-rest', template: '/courses/:courseId', path: '/courses/course-1', status: 200 });
    expect(anon).toMatchObject({ caller: 'unattributed', template: null, status: 401 });
    expect(JSON.stringify(t)).not.toContain(r.body.course_id);
    await api.close();
  });

  it('T-REC-2 the caller header changes nothing: same status, body shape and database effect with and without a recorder', async () => {
    const outcomes: unknown[] = [];
    for (const [useRecorder, header] of [[false, true], [false, false], [true, true], [true, false]] as const) {
      const { h, api } = await appWith(useRecorder ? createRecorder({ clock: clock() }) : undefined);
      const token = await h.teacher();
      const hdr = header ? { [CALLER_HEADER]: 'mcp:create_course' } : undefined;
      const r = await api.call(token, 'POST', '/courses', courseBody({ title: 'Parity' }), hdr);
      const rows = await db.query.courses.findMany({ where: (c, { eq }) => eq(c.id, r.body.course_id) });
      const bad = await api.call('x'.repeat(43), 'GET', '/courses', undefined, { [CALLER_HEADER]: 'mcp:list_courses' }); // a forged tag cannot authorize
      const none = await api.call(null, 'POST', '/courses', courseBody(), { [CALLER_HEADER]: 'scenario-rest' });
      outcomes.push({ status: r.status, shape: shapeOf(r.body), rows: rows.map((x) => x.title), bad: [bad.status, bad.body], none: [none.status, none.body] });
      await api.close();
    }
    for (const o of outcomes) expect(o).toEqual(outcomes[0]);
    expect((outcomes[0] as { bad: number[] }).bad[0]).toBe(401);
  });

  it('T-REC-3 an app built without a recorder ignores the header and mounts no middleware', async () => {
    const h = await harness();
    const app = createApp({ ...h.deps, removedRetentionDays: 14, studentRoutesEnabled: false, bindHost: '127.0.0.1' });
    const layers = (app.router as unknown as { stack: { name: string }[] }).stack.map((l) => l.name);
    expect(layers.some((n) => /record|trace/i.test(n))).toBe(false);
  });

  it('T-REC-4 Slack calls are attributed to the entry point that caused them; a failure records the error name, never its message', async () => {
    const rec = createRecorder({ clock: clock() });
    const fake = new FakeSlack();
    const slack = rec.slack(fake);
    rec.beginStep(1, 's');
    await rec.run({ origin: 'tick', caller: 'tick' }, () => slack.postCard('UREAL12345', buildCardMessage({ id: 'c', question: 'Q', options: ['a', 'b'] })));
    await slack.lookupEmail('someone@x.test');
    fake.failNextPost = new Error('boom ' + 'xox' + 'b-123456789012-abcdefghijklmnop');
    await expect(slack.postCard('UREAL12345', { text: 't', blocks: [] })).rejects.toThrow();
    const ev = rec.trace({ studentRoutesEnabled: false }).steps[0]!.events;
    expect(ev.map((e) => e.kind === 'slack' && [e.call, e.origin, e.error])).toEqual([['postCard', 'tick', undefined], ['lookupEmail', 'unattributed', undefined], ['postCard', 'unattributed', 'Error']]);
    expect(JSON.stringify(ev)).not.toMatch(/xoxb|someone@|UREAL/);
  });

  it('T-REC-5 handler runs record the action id and an outcome code', async () => {
    const rec = createRecorder({ clock: clock() });
    rec.beginStep(1, 's');
    const replies: Record<string, { text: string; blocks?: never[] } | undefined> = {
      a: { text: REJECT_TEXT.not_open },
      b: { text: ERROR_TEXT },
      c: { text: 'Not quite. The right answer is 1: x.' },
      d: { text: 'Thanks. You rated it Easy.' },
      e: undefined,
    };
    const router = rec.router({
      action: (_p, h) => void (handlers.push(h)),
    });
    const handlers: ((a: ClickArgs) => Promise<void>)[] = [];
    for (const m of Object.values(replies)) router.action(/x/, async (a) => void (m && (await a.respond({ ...m, replace_original: true }))));
    const click = (h: (a: ClickArgs) => Promise<void>) => h({ ack: async () => {}, action: { action_id: 'answer_1' }, body: { user: { id: 'UREAL12345' } }, respond: async () => {} });
    for (const h of handlers) await click(h);
    const rating = buildRatingMessage({ id: 'c' }, 0);
    rec.router({ action: (_p, h) => void click(h) }).action(/x/, async (a) => void (await a.respond({ ...rating, replace_original: true })));
    const out = rec.trace({ studentRoutesEnabled: false }).steps[0]!.events.map((e) => e.kind === 'click' && e.outcome);
    expect(out).toEqual(['rejected:not_open', 'error', 'wrong', 'replaced', 'no_response', 'rating_prompt']);
  });

  it('T-REC-6 entry points are recorded in order with a redacted summary', async () => {
    const rec = createRecorder({ clock: clock() });
    rec.beginStep(1, 's');
    const r = await rec.within({ origin: 'tick', caller: 'tick' }, 'runTick', async () => ({ sent: 1 }), (x) => x);
    expect(r).toEqual({ sent: 1 });
    expect(rec.trace({ studentRoutesEnabled: false }).steps[0]!.events[0]).toMatchObject({ kind: 'entry', origin: 'tick', label: 'runTick', detail: { sent: 1 } });
  });
});

describe('no secret reaches the files (T-LEAK)', () => {
  it('T-LEAK-1 seeded fake secrets, emails and ids never appear in trace.json or trace.html', async () => {
    const rec = createRecorder({ clock: clock() });
    const { h, api } = await appWith(rec);
    const teacherEmail = h.email('leak-teacher');
    const { issueTeacherToken } = await import('../services/auth.js');
    const token = await issueTeacherToken(db, { email: teacherEmail, fullName: 'Leaky Teacher' });
    const studentEmail = h.matched('leakstudent');
    const slackId = h.slack.directory.get(studentEmail)!.slackId;
    const fakeBot = 'xox' + 'b-999999999999-LEAKLEAKLEAKLEAK';
    const dbUrl = process.env.TEST_DATABASE_URL ?? 'postgres://u:p@localhost/x';
    rec.redactor.addSecret(token);
    rec.redactor.addSecret(dbUrl);
    rec.redactor.addSlackId(slackId);
    rec.beginStep(1, `step with ${studentEmail} and ${fakeBot}`);
    const hdr = { [CALLER_HEADER]: 'scenario-rest' };
    const c = await api.call(token, 'POST', '/courses', courseBody({ title: `Contact ${studentEmail} or ${fakeBot}`, material_url: `https://x.test/m?email=${encodeURIComponent(studentEmail)}&token=${token}` }), hdr);
    await api.call(token, 'POST', `/courses/${c.body.course_id}/flashcards`, { flashcards: [cardBody({ question: `Bearer ${token} ${dbUrl} ${studentEmail}` })] }, hdr);
    await api.call(token, 'POST', `/courses/${c.body.course_id}/students`, { students: [{ email: studentEmail, name: 'Leak Student' }] }, hdr);
    await api.call(token, 'GET', `/courses/${c.body.course_id}/students?email=${encodeURIComponent(studentEmail)}&access_token=${fakeBot}`, undefined, hdr);
    await api.call(`${token}x`, 'GET', `/courses/${token}`, undefined, hdr); // a token used as a path segment
    await rec.slack(h.slack).postCard(slackId, { text: `hi ${studentEmail}`, blocks: [] });
    const dir = await mkdtemp(join(tmpdir(), 'trace-leak-'));
    const trace = rec.trace({ studentRoutesEnabled: false });
    await writeTrace(join(dir, 'trace.json'), trace, rec.redactor);
    const html = renderTrace(parseTraceFile(await readFile(join(dir, 'trace.json'), 'utf8')), []);
    assertPageClean(rec.redactor, html);
    await writeFile(join(dir, 'trace.html'), html);
    const needles = [token, `${token}x`, teacherEmail, studentEmail, encodeURIComponent(studentEmail), slackId, fakeBot, dbUrl, 'Leaky Teacher', 'Leak Student', 'leakstudent', 'leak-teacher'];
    expect(await filesContaining(dir, needles)).toEqual([]);
    const written = await readFile(join(dir, 'trace.json'), 'utf8');
    expect(written.length).toBeGreaterThan(500);
    expect(written).toContain('"POST"'); // the files are not empty, so the scan above means something
    expect(written).toContain('user-1');
    await api.close();
  });

  it('T-LEAK-2 an unredacted trace is refused and no file is written', async () => {
    const rec = createRecorder({ clock: clock() });
    const t = rec.trace({ studentRoutesEnabled: false });
    t.steps.push({ n: 1, name: 'leak ann@x.test', tableDelta: {}, events: [] });
    const dir = await mkdtemp(join(tmpdir(), 'trace-refuse-'));
    await expect(writeTrace(join(dir, 'trace.json'), t, rec.redactor)).rejects.toThrow(/nothing was written/);
    expect(await readdir(dir)).toEqual([]);
    expect(serializeTrace(t)).toContain('ann@x.test'); // the serializer alone does not scrub: the scan is the guard
  });
});

describe('image cards in the trace (decision 0034)', () => {
  it('T-IMG-1 records an image as a placeholder with its size and alt text, never its bytes', async () => {
    const rec = createRecorder({ clock: clock() });
    const fake = new FakeSlack();
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('DISTINCTIVE-PIXEL-BYTES-123')]);
    rec.beginStep(1, 'one');
    await rec.slack(fake).postCard('U1', buildCardMessage({ id: 'c', question: 'Q?', options: ['a', 'b'] }, { imageAbove: true }), { png, width: 1200, height: 630, alt: 'Q?' });
    await rec.slack(fake).postCard('U1', { text: 'plain', blocks: [] });
    const [withImage, plain] = rec.trace({ studentRoutesEnabled: false }).steps[0]!.events;
    expect(withImage).toMatchObject({ kind: 'slack', call: 'postCard', req: { image: '<image 1200x630>', alt: 'Q?' } });
    expect((plain as { req: object }).req).not.toHaveProperty('image');
    const text = JSON.stringify(rec.trace({ studentRoutesEnabled: false }));
    expect(text).not.toContain('DISTINCTIVE');
    expect(text).not.toContain(png.toString('base64'));
    expect(text).not.toContain(png.toString('hex'));
    expect(fake.posted[0]!.image!.png.equals(png)).toBe(true); // the real call got the bytes
  });
});
