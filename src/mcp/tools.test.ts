import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createRestClient } from './client.js';
import { registerTools, tools } from './tools.js';

// M1 to M4 of docs/test-plan.md against a fake fetch.
const TOKEN = 'tok_SECRET_0123456789abcdefghij';
const BASE = 'http://api.test:3000';
const C = '11111111-1111-4111-8111-111111111111';
const S = '22222222-2222-4222-8222-222222222222';
const F = '33333333-3333-4333-8333-333333333333';
const card = { question: 'Q', options: ['a', 'b'], correct_option: 0, is_assessment: false };

interface Seen { method: string; url: string; headers: Record<string, string>; body: unknown }
async function setup(reply: (req: Seen) => Response | Promise<Response> = () => Response.json({ ok: 1 })) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const req = { method: init.method!, url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    seen.push(req);
    return reply(req);
  }) as unknown as typeof fetch;
  const server = new McpServer({ name: 'retain', version: 't' });
  registerTools(server, createRestClient({ baseUrl: BASE, token: TOKEN, fetchImpl }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
  return { seen, client, call };
}

const confirmed = { confirmed: true };
// tool -> arguments, expected method, path, body (M1: one row per tool)
const M1: [string, Record<string, unknown>, string, string, unknown][] = [
  ['create_course', { title: 'T', material_url: 'https://x.test/m', ends_at: '2026-12-20T22:59:00Z' }, 'POST', '/courses', { title: 'T', material_url: 'https://x.test/m', ends_at: '2026-12-20T22:59:00Z' }],
  ['list_courses', {}, 'GET', '/courses', undefined],
  ['get_course', { course_id: C }, 'GET', `/courses/${C}`, undefined],
  ['update_course', { course_id: C, ends_at: '2026-12-21T22:59:00Z' }, 'PATCH', `/courses/${C}`, { ends_at: '2026-12-21T22:59:00Z' }],
  ['start_course', { course_id: C, ...confirmed }, 'POST', `/courses/${C}/start`, undefined],
  ['stop_course', { course_id: C, ...confirmed }, 'POST', `/courses/${C}/stop`, undefined],
  ['delete_course', { course_id: C, ...confirmed }, 'DELETE', `/courses/${C}`, undefined],
  ['add_flashcards', { course_id: C, flashcards: [card] }, 'POST', `/courses/${C}/flashcards`, { flashcards: [card] }],
  ['list_flashcards', { course_id: C }, 'GET', `/courses/${C}/flashcards`, undefined],
  ['update_flashcard', { flashcard_id: F, is_assessment: true }, 'PATCH', `/flashcards/${F}`, { is_assessment: true }],
  ['delete_flashcard', { flashcard_id: F }, 'DELETE', `/flashcards/${F}`, undefined],
  ['enroll_students', { course_id: C, students: [{ email: 'a@x.test', name: 'Ann' }] }, 'POST', `/courses/${C}/students`, { students: [{ email: 'a@x.test', name: 'Ann' }] }],
  ['list_students', { course_id: C }, 'GET', `/courses/${C}/students`, undefined],
  ['remove_student', { course_id: C, student_id: S, ...confirmed }, 'DELETE', `/courses/${C}/students/${S}`, undefined],
  ['get_class_progress', { course_id: C }, 'GET', `/courses/${C}/progress`, undefined],
  ['get_student_progress', { course_id: C, student_id: S }, 'GET', `/courses/${C}/students/${S}/progress`, undefined],
];

describe('M1 each tool calls its route with the token', () => {
  it('has exactly the 16 tools of the table', async () => {
    const { client } = await setup();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(M1.map((r) => r[0]).sort());
  });
  it.each(M1)('%s', async (name, args, method, path, body) => {
    const { seen, call } = await setup();
    const r = await call(name, args);
    expect(r.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method, url: BASE + path, body });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
  it('shows a 204 as ok and never forwards confirmed', async () => {
    const { seen, call } = await setup(() => new Response(null, { status: 204 }));
    const r = await call('delete_course', { course_id: C, confirmed: true });
    expect(JSON.parse(r.content[0]!.text)).toEqual({ ok: true });
    expect(seen[0]!.body).toBeUndefined();
  });
  it('the doc table lists the same tools', () => {
    const doc = readFileSync('docs/mcp-teacher-api.md', 'utf8');
    const names = [...doc.matchAll(/^\| `([a-z_]+)` \| `(GET|POST|PATCH|DELETE) /gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(tools.map((t) => t.name).sort());
  });
});

describe('M2 API errors are tool errors', () => {
  it('shows code and message', async () => {
    const { call } = await setup(() => Response.json({ error: { code: 'course_not_draft', message: 'Only a draft course can be started.' } }, { status: 409 }));
    const r = await call('start_course', { course_id: C, ...confirmed });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('course_not_draft: Only a draft course can be started.');
  });
  it('a message that echoes the token is redacted', async () => {
    const { call } = await setup(() => Response.json({ error: { code: 'invalid_request', message: `bad ${TOKEN}` } }, { status: 400 }));
    expect((await call('get_course', { course_id: C })).content[0]!.text).not.toContain(TOKEN);
  });
  it('a fetch error with a URL and the token inside shows neither', async () => {
    const { call } = await setup(() => { throw new Error(`connect ECONNREFUSED ${BASE}/courses Authorization: Bearer ${TOKEN}`); });
    const r = await call('list_courses', {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('unreachable');
    expect(r.content[0]!.text).not.toContain(TOKEN);
    expect(r.content[0]!.text).not.toContain('/courses');
  });
  it('a non-JSON or body-less error is bad_response', async () => {
    const { call } = await setup(() => new Response('<html>', { status: 502 }));
    expect((await call('list_courses', {})).content[0]!.text).toMatch(/^bad_response: .*502/);
  });
});

describe('M3 invalid input is rejected before any HTTP call', () => {
  const bad: [string, string, Record<string, unknown>][] = [
    ['one option', 'add_flashcards', { course_id: C, flashcards: [{ ...card, options: ['a'] }] }],
    ['ten options', 'add_flashcards', { course_id: C, flashcards: [{ ...card, options: Array(10).fill('a') }] }],
    ['negative correct_option', 'add_flashcards', { course_id: C, flashcards: [{ ...card, correct_option: -1 }] }],
    ['unknown card key', 'add_flashcards', { course_id: C, flashcards: [{ ...card, extra: 1 }] }],
    ['no cards', 'add_flashcards', { course_id: C, flashcards: [] }],
    ['not a uuid', 'get_course', { course_id: '../x' }],
    ['ends_at without a zone', 'create_course', { title: 'T', material_url: 'https://x.test', ends_at: '2026-12-20T22:59:00' }],
    ['missing ends_at', 'create_course', { title: 'T', material_url: 'https://x.test' }],
    ['threshold 0', 'update_course', { course_id: C, assessment_pass_threshold: 0 }],
    ['unknown key', 'list_courses', { teacher: 'x' }],
    ['bad email', 'enroll_students', { course_id: C, students: [{ email: 'nope', name: 'A' }] }],
    ['javascript url', 'create_course', { title: 'T', material_url: 'javascript:alert(1)', ends_at: '2026-12-20T22:59:00Z' }],
  ];
  it.each(bad)('%s', async (_n, name, args) => {
    const { seen, call } = await setup();
    expect((await call(name, args)).isError).toBe(true);
    expect(seen).toHaveLength(0);
  });
  it('question plus options over 2,900 characters is refused by the REST API (the schema keeps the limit in the description only)', () => {
    // The 2,900 rule is enforced by the REST API (rest-api.md); the description tells the model, the API returns invalid_request.
    expect(tools.find((t) => t.name === 'add_flashcards')!.description).toContain('2,900');
  });
});

describe('confirmed cannot be bypassed', () => {
  const guarded = [['start_course', { course_id: C }], ['stop_course', { course_id: C }], ['delete_course', { course_id: C }], ['remove_student', { course_id: C, student_id: S }]] as const;
  const values: [string, Record<string, unknown>][] = [
    ['omitted', {}], ['false', { confirmed: false }], ["string 'true'", { confirmed: 'true' }], ['1', { confirmed: 1 }], ['null', { confirmed: null }], ['array', { confirmed: [true] }],
    ['extra key next to true', { confirmed: true, force: true }],
  ];
  for (const [name, base] of guarded) {
    it.each(values)(`${name}: %s`, async (_label, extra) => {
      const { seen, call } = await setup();
      expect((await call(name, { ...base, ...extra })).isError).toBe(true);
      expect(seen).toHaveLength(0);
    });
  }
  it('no other tool needs confirmation', () => {
    expect(tools.filter((t) => JSON.stringify(z2(t)).includes('confirmed')).map((t) => t.name).sort()).toEqual(['delete_course', 'remove_student', 'start_course', 'stop_course']);
  });
});
const z2 = (t: (typeof tools)[number]) => Object.keys((t.input as unknown as { shape: object }).shape);

describe('M4 descriptions carry the rules', () => {
  const d = (n: string) => tools.find((t) => t.name === n)!.description;
  it('start_course and stop_course say they message students', () => {
    expect(d('start_course')).toMatch(/MESSAGES STUDENTS/);
    expect(d('stop_course')).toMatch(/MESSAGES STUDENTS/);
  });
  it('start_course treats the user\'s explicit request to start as the confirmation and does not ask again (decision 0036)', () => {
    expect(d('start_course')).toMatch(/that request IS the confirmation: call this at once with confirmed: true/);
    expect(d('start_course')).toMatch(/do not ask for a second approval/);
    expect(d('start_course')).not.toMatch(/call list_flashcards and show the user ALL cards/);
  });
  it('add_flashcards says the question is an image: 500 characters, plain text, supported characters, the refusal codes (decision 0034)', () => {
    expect(d('add_flashcards')).toMatch(/IMAGE: at most 500 characters, plain text only/);
    expect(d('add_flashcards')).toMatch(/Latin with umlauts, Cyrillic including Ukrainian/);
    expect(d('add_flashcards')).toMatch(/no emoji, Arabic, Hebrew or Asian scripts/);
    expect(d('add_flashcards')).toMatch(/question_too_long, unsupported_character or empty_question/);
    expect(d('add_flashcards')).toMatch(/Put long context into the options or the material_url/);
  });
  it('update and delete flashcard say draft only', () => {
    expect(d('update_flashcard')).toMatch(/DRAFT COURSES ONLY/);
    expect(d('delete_flashcard')).toMatch(/DRAFT COURSES ONLY/);
  });
  it('add_flashcards states the card rules', () => {
    for (const w of ['2 to 9', '0-based', '2,900', 'assessment_closed']) expect(d('add_flashcards')).toContain(w);
  });
  it('update_course states the active-course rules', () => {
    for (const w of ['threshold_locked', 'ends_at_shortened', 'course_finished']) expect(d('update_course')).toContain(w);
  });
  it('enroll_students mentions Slack matching, the 14 day restore and the first card on a running course', () => {
    for (const w of ['slack_matched', '14 days', 'RUNNING']) expect(d('enroll_students')).toContain(w);
  });
});
