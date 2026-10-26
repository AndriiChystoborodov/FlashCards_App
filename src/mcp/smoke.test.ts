import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, type Harness } from '../api/harness.js';

// Smoke test (docs/test-plan.md "MCP"): the real stdio server in a child process against the real REST app on the test database.
const ROOT = resolve(import.meta.dirname, '../..');
const run = (env: Record<string, string>): ChildProcessWithoutNullStreams =>
  spawn(process.execPath, ['--import', pathToFileURL(`${ROOT}/node_modules/tsx/dist/loader.mjs`).href, `${ROOT}/src/mcp/index.ts`], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env } });

/** Collects stdout and stderr; every stdout line must be a JSON-RPC message. */
function session(child: ChildProcessWithoutNullStreams) {
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const lines = () => out.split('\n').filter((l) => l !== '');
  let nextId = 1;
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  const poll = setInterval(() => {
    for (const l of lines()) {
      const m = JSON.parse(l) as { id?: number };
      if (m.id !== undefined && waiters.has(m.id)) waiters.get(m.id)!(m as Record<string, unknown>), waiters.delete(m.id);
    }
  }, 10);
  const send = (method: string, params: unknown = {}) =>
    new Promise<{ result?: any; error?: unknown }>((res, rej) => {
      const id = nextId++;
      const t = setTimeout(() => rej(new Error(`no answer to ${method}`)), 15_000);
      waiters.set(id, (m) => (clearTimeout(t), res(m as never)));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return {
    send,
    call: async (name: string, args: unknown) => (await send('tools/call', { name, arguments: args })).result as { isError?: boolean; content: { text: string }[] },
    init: async () => {
      await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    stdoutLines: lines,
    stderr: () => err,
    exited: () => new Promise<number | null>((res) => (child.exitCode !== null ? res(child.exitCode) : child.once('exit', res))),
    stop: () => (clearInterval(poll), child.kill()),
  };
}
const expectProtocolOnly = (lines: string[]) => {
  for (const l of lines) expect(JSON.parse(l)).toMatchObject({ jsonrpc: '2.0' });
};

describe('stdio server against the real REST app', () => {
  let h: Harness;
  let token: string;
  beforeAll(async () => {
    h = await harness();
    token = await h.teacher();
  });
  afterAll(() => h.api.close());

  it('lists 16 tools, calls one tool per family, maps an API error, and writes only protocol messages to stdout', async () => {
    const s = session(run({ RETAIN_API_URL: h.api.url, RETAIN_API_TOKEN: token }));
    try {
      await s.init();
      const list = await s.send('tools/list');
      expect(list.result.tools.map((t: { name: string }) => t.name)).toHaveLength(16);
      const ok = async (name: string, args: unknown) => {
        const r = await s.call(name, args);
        expect(r.isError, r.content[0]!.text).toBeUndefined();
        return JSON.parse(r.content[0]!.text);
      };
      const course = await ok('create_course', { title: 'MCP smoke', material_url: 'https://x.test/m', ends_at: '2026-01-16T22:59:00Z' });
      const cid = course.course_id as string;
      const cards = await ok('add_flashcards', { course_id: cid, flashcards: [{ question: 'Q1', options: ['a', 'b'], correct_option: 0, is_assessment: true }, { question: 'Q2', options: ['a', 'b', 'c'], correct_option: 2 }] });
      const email = h.matched('ann');
      expect((await ok('enroll_students', { course_id: cid, students: [{ email, name: 'Ann' }] })).students[0]).toMatchObject({ enrolled: true, slack_matched: true });
      expect((await ok('list_flashcards', { course_id: cid })).flashcards).toHaveLength(2);
      const refused = await s.call('start_course', { course_id: cid });
      expect(refused.isError).toBe(true); // confirmed missing
      expect(h.slack.posted).toHaveLength(0);
      expect((await ok('start_course', { course_id: cid, confirmed: true })).status).toBe('active');
      expect(h.slack.posted.length).toBeGreaterThan(0);
      const again = await s.call('start_course', { course_id: cid, confirmed: true });
      expect(again).toMatchObject({ isError: true });
      expect(again.content[0]!.text).toMatch(/^course_not_draft: /);
      const edit = await s.call('update_flashcard', { flashcard_id: cards.flashcards[0].flashcard_id, is_assessment: false });
      expect(edit.content[0]!.text).toMatch(/^course_not_draft: /);
      expect((await ok('get_class_progress', { course_id: cid })).students).toHaveLength(1);
      const bad = (await s.call('get_course', { course_id: '99999999-9999-4999-8999-999999999999' })).content[0]!.text;
      expect(bad).toMatch(/^not_found: /);
    } finally {
      s.stop();
    }
    expectProtocolOnly(s.stdoutLines());
    expect(s.stderr()).not.toContain(token);
    expect(s.stdoutLines().join('\n')).not.toContain(token);
  }, 60_000);

  it('a wrong token gives unauthorized as a tool error', async () => {
    const s = session(run({ RETAIN_API_URL: h.api.url, RETAIN_API_TOKEN: 'x'.repeat(43) }));
    try {
      await s.init();
      const r = await s.call('list_courses', {});
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/^unauthorized: /);
    } finally {
      s.stop();
    }
    expectProtocolOnly(s.stdoutLines());
  }, 30_000);

  it.each([
    ['no URL', { RETAIN_API_TOKEN: 'tok_SECRET_value_123' }, 'RETAIN_API_URL is not set'],
    ['no token', { RETAIN_API_URL: 'http://127.0.0.1:3000' }, 'RETAIN_API_TOKEN is not set'],
    ['a URL with credentials', { RETAIN_API_URL: 'http://me:hunter2@127.0.0.1:3000', RETAIN_API_TOKEN: 'tok_SECRET_value_123' }, 'must not contain a user name or password'],
  ])('refuses to start: %s', async (_n, env, message) => {
    const s = session(run(env));
    expect(await s.exited()).toBe(1);
    expect(s.stderr()).toContain(message);
    for (const secret of ['tok_SECRET_value_123', 'hunter2']) expect(s.stderr()).not.toContain(secret);
    expect(s.stdoutLines()).toEqual([]); // nothing on stdout, including on the refusal path
    s.stop();
  }, 30_000);
});
