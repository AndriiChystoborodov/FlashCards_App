import { describe, expect, it } from 'vitest';
import { createRedactor } from './redact.js';

const TOKEN = 'rT7kQ9xLm2PaVz8cYw4nBd6HsJf1GeUo3AiKt5MxNb0'; // looks like a teacher token
const BOT = 'xox' + 'b-123456789012-abcdefghijklmnop'; // split so that no source line looks like a real Slack token to secret scanners
const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

const out = (v: unknown, r = createRedactor()) => JSON.stringify(r.json(v));

describe('redactor (T-RED)', () => {
  it('T-RED-1 emails: nested, in arrays, in object keys, in longer strings, upper case, encoded', () => {
    const o = out({
      a: { b: [{ c: 'write to Ann.Smith+x@Example.COM now' }] },
      'key-bob@x.test': 1,
      enc: 'GET /s?e=ann%40x.test&z=1',
      uni: 'ann\\u0040x.test',
      upper: 'ANN@X.TEST',
      email: 'plain@x.test',
    });
    expect(o).not.toMatch(/@|%40|u0040/i);
    expect(o).not.toMatch(/ann|bob|plain/i);
  });

  it('T-RED-2 bearer headers and slack tokens in every case', () => {
    const o = out(['Authorization: Bearer abcdefgh12345678', 'BEARER abcdefgh12345678', 'bearer%20abcdefgh12345678', BOT, BOT.toUpperCase(), 'xapp-1-A0123-456-abcdef', 'xoxp-1-2-3-abcdef', 'xoxe.xoxp-1-AbCdEf']);
    expect(o).not.toMatch(/abcdefgh12345678|xox[a-z]-|xapp-|xoxe\./i);
  });

  it('T-RED-3 database URLs with credentials', () => {
    const o = out({ e: 'connect postgres://retain:hunter2@localhost:5433/retain_dev failed', f: 'mongodb+srv://u:p4ss@cluster/x', g: 'postgresql://x' });
    expect(o).not.toMatch(/hunter2|p4ss|retain:|postgres/i);
  });

  it('T-RED-4 registered secrets: any case, URL-encoded, inside an error text, in a path', () => {
    const r = createRedactor();
    r.addSecret('S3cr3t/value+x');
    const o = out({ m: 'failed with s3cr3t/value+x here', p: '/x?k=S3cr3t%2Fvalue%2Bx', arr: ['S3CR3T/VALUE+X'] }, r);
    expect(o).not.toMatch(/s3cr3t/i);
    expect(r.path('/c?token=S3cr3t%2Fvalue%2Bx', null)).not.toMatch(/s3cr3t/i);
  });

  it('T-RED-5 secret keys are replaced whatever the value, at any depth', () => {
    const o = out({ Authorization: 'x', n: [{ api_token: 'plain', Password: 'p', nested: { 'X-Secret': 's', token: 1 } }], tokenHash: 'h' });
    expect(o).not.toMatch(/"x"|plain|"p"|"s"|"h"/);
    expect(o.match(/\[redacted\]/g)).toHaveLength(6);
  });

  it('T-RED-6 bare token-looking strings and the known token shape', () => {
    const o = out({ s: `see ${TOKEN} please`, short: 'assessment_pass_threshold', hex: 'a'.repeat(8) + '0'.repeat(24) });
    expect(o).not.toContain(TOKEN);
    expect(o).toContain('assessment_pass_threshold');
  });

  it('T-RED-7 slack ids: real shape, registered fake ones, JSON inside a string', () => {
    const r = createRedactor();
    r.addSlackId('UANN');
    const o = out({ to: 'D-UANN', who: 'U01ABCDEF2G', value: JSON.stringify({ u: 'W9ZZZZZZZZ' }), slack_id: 'XYZ' }, r);
    expect(o).not.toMatch(/UANN|U01ABC|W9ZZ|XYZ/);
    expect(out({ a: 'UANN', b: 'UANN' }, r)).toBe(JSON.stringify({ a: 'U-1', b: 'U-1' }));
  });

  it('T-RED-8 uuids become stable aliases named by the key or the route parameter', () => {
    const r = createRedactor();
    expect(r.path(`/courses/${UUID}/students`, '/courses/:courseId/students')).toBe('/courses/course-1/students');
    expect(out({ course_id: UUID, flashcard_id: '11111111-1111-4111-8111-111111111111' }, r)).toBe(JSON.stringify({ course_id: 'course-1', flashcard_id: 'card-1' }));
    expect(out({ x: UUID.toUpperCase() }, createRedactor())).not.toContain(UUID.toUpperCase());
  });

  it('T-RED-9 aliases are deterministic for the same order of first sight, and labels choose the prefix', () => {
    const run = () => {
      const r = createRedactor();
      r.label('t@x.test', 'teacher');
      return out({ a: 't@x.test', b: ['s1@x.test', 's2@x.test', 's1@x.test'] }, r);
    };
    expect(run()).toBe(run());
    expect(run()).toBe(JSON.stringify({ a: 'teacher-1', b: ['user-1', 'user-2', 'user-1'] }));
  });

  it('T-RED-10 control characters, huge strings, depth and item caps', () => {
    const r = createRedactor();
    expect(out('a\u0000b‮c', r)).not.toMatch(/\\u0000|\\u202e/i);
    const t0 = Date.now();
    const big = r.text('a'.repeat(1_000_000));
    expect(big.length).toBeLessThan(2100);
    expect(Date.now() - t0).toBeLessThan(2000);
    let deep: unknown = 'x';
    for (let i = 0; i < 100; i++) deep = { d: deep };
    expect(out(deep, r)).toContain('too deep');
    expect((r.json(new Array(500).fill(1)) as unknown[]).length).toBe(201);
  });

  it('T-RED-11 the final scan passes on redacted output and throws, naming only the detector, on raw text', () => {
    const r = createRedactor();
    r.addSecret('LiveSecretValue1');
    r.addSlackId('UFAKE1');
    const clean = JSON.stringify(r.json({ m: `${BOT} ann@x.test LiveSecretValue1 UFAKE1 ${UUID} postgres://a:b@c/d Bearer abcdefgh12345678` }));
    expect(() => r.assertClean(clean)).not.toThrow();
    for (const raw of ['ann@x.test', BOT, 'Bearer abcdefgh12345678', UUID, 'postgres://a:b@c/d', 'U01ABCDEF2G', TOKEN, 'x livesecretvalue1', 'UFAKE1']) {
      expect(() => r.assertClean(`{"m":"${raw}"}`), raw).toThrow(/nothing was written/);
    }
    try {
      r.assertClean('ann@x.test');
    } catch (e) {
      expect((e as Error).message).not.toContain('ann@x.test');
    }
  });

  it('T-RED-12 a Date, bigint, undefined and a circular object do not break it', () => {
    const c: Record<string, unknown> = { a: 1 };
    c.self = c;
    expect(() => out({ d: new Date('2026-01-01T00:00:00Z'), b: 10n, u: undefined, c })).not.toThrow();
  });

  // Regression tests for the independent attack review (decision 0032).
  const leaks = (v: unknown, needles: RegExp, r = createRedactor()) => {
    const o = JSON.stringify(r.json(v));
    expect(o).not.toMatch(needles);
    expect(() => r.assertClean(o)).not.toThrow();
  };

  it('T-RED-13 query strings, userinfo and DSN pairs are redacted by key', () => {
    leaks({ p: 'GET /courses?token=abcdefgh&email=bob%40corp.example', m: 'https://x.test/m?token=zzzzyyyy', j: '/x;jsessionid=abcdef1234', d: 'host=db port=5432 user=r password=hunter22 dbname=x', u: 'postgres://u:my pass word@h/x' }, /abcdefgh|zzzzyyyy|abcdef1234|hunter22|bob|pass word/);
    expect(createRedactor().path('/c?access_token=abcdefgh&email=bob%40corp.example', null)).not.toMatch(/abcdefgh|bob/);
  });

  it('T-RED-14 more secret-looking and person-looking keys', () => {
    leaks({ pwd: 'hunter2x', pass: 'hunter2x', bearer: 'hunter2x', jwt: 'hunter2x', sessionId: 'hunter2x', auth: 'hunter2x', key: 'hunter2x', privateKey: 'hunter2x', signature: 'hunter2x', sig: 'hunter2x', passphrase: 'hunter2x', displayName: 'Alice Doe', student_name: 'Alice Doe', firstName: 'Alice', username: 'alicedoe' }, /hunter2x|Alice|alicedoe/);
    expect(out({ assessment_pass_threshold: 90, fileName: 'a.txt' })).toContain('90');
  });

  it('T-RED-15 bearer, slack token, email and encoding variants', () => {
    leaks(['Bearer:abcDEF1234567', 'Bearer "abcDEF1234567"', 'Bearer%2520abcDEF1234567', 'Bear​er abcDEF1234567', 'xo​xb-1234-abcdefgh', 'xoxb.1234.abcdefgh', 'ghp_abcdefghijklmnop', 'https://hooks.slack.com/services/T01/B01/abcdefgh', 'eyJhbGciOi.eyJzdWIiOiJ4.abcdef', 'Basic dXNlcjpwYXNz'], /abcDEF1234567|abcdefgh|dXNlcjpwYXNz|eyJ/);
    leaks(['"bob smith"@corp.example', 'bob@localhost', 'bob@münchen.example', 'bob​@corp.example', 'bob＠corp.example', 'bob%2540corp.example', 'bob&#64;corp.example', 'bob@[192.168.1.1]'], /bob|corp\.example|localhost/);
  });

  it('T-RED-16 slack ids with a digit in 8 or more characters, other prefixes, registered ids in any case; words stay', () => {
    const r = createRedactor();
    r.addSlackId('u_fake1');
    leaks(['T0123ABCDEF', 'B0123ABCDEF', 'G0123ABCD', 'U0123ABC', 'U_FAKE1'], /T0123|B0123|G0123|U0123|fake1/i, r);
    expect(out('CONTAINERS and DISTRIBUTED UNDERSTANDING')).toBe('"CONTAINERS and DISTRIBUTED UNDERSTANDING"');
  });

  it('T-RED-17 scheme-less credentials and registered secrets in other encodings', () => {
    const r = createRedactor();
    r.addSecret('p4ss w0rd-xyz');
    leaks(['retain:pw123456@localhost:5433/x', 'p4ss+w0rd-xyz', 'p4ss%2520w0rd-xyz', Buffer.from('p4ss w0rd-xyz').toString('base64'), Buffer.from('p4ss w0rd-xyz').toString('base64url'), 'P4SS W0RD-XYZ'], /pw123456|p4ss|w0rd|UDRzcyB3/i, r);
  });

  it('T-RED-18 long letter-only strings and digit-only strings are tokens', () => {
    leaks(['abcdefghijklmnopqrstuvwxyzabcdef', '12345678901234567890123'], /abcdefghijklmnop|123456789012/);
  });

  it('T-RED-19 non-plain values: Symbol, function, String object, Buffer, throwing getter and proxy', () => {
    const bad = { get x(): string { throw new Error('boom'); } };
    const prox = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
    leaks({ s: Symbol('bob@corp.example'), f: () => 'bob@corp.example', o: new String('bob@corp.example'), b: Buffer.from('bob@corp.example'), bad, prox }, /bob|corp\.example/);
  });

  it('T-RED-20 the final scan is linear: 200 long runs and a 100,000 character run finish quickly', () => {
    const r = createRedactor();
    const t0 = Date.now();
    const quick = (x: string) => {
      try {
        r.assertClean(x); // it may throw (a long run of letters is a token); only the time matters here
      } catch {
        // expected
      }
    };
    quick(JSON.stringify(new Array(200).fill('a'.repeat(1990))));
    for (const run of ['a', 'a.', 'a-', '%41', 'a@']) quick(run.repeat(Math.ceil(100_000 / run.length)));
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
