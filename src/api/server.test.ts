import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createControlledClock } from '../clock.js';
import { db, pool } from '../db/testDb.js';
import { FakeSlack } from '../slack/fake.js';
import { createApp, type ApiDeps } from './app.js';
import { assertStudentRoutesAllowed, isLoopbackAddress, isLoopbackHost } from './loopback.js';
import { startServer } from './server.js';

afterAll(() => pool.end());

const deps = (studentRoutesEnabled: boolean, bindHost: string): ApiDeps => ({
  db, clock: createControlledClock(new Date('2026-01-05T09:00:00Z')), tenantTimezone: 'Europe/Zurich', slack: new FakeSlack(), removedRetentionDays: 14, studentRoutesEnabled, bindHost,
});

/** Listens on 127.0.0.1 (whatever bindHost the app was built with) and asks the student route for an unknown user: "User not found." means mounted, "No such route." means absent. */
async function studentRouteMounted(app: Express): Promise<boolean> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/users/00000000-0000-4000-8000-000000000000/courses`);
    const msg = ((await res.json()) as { error: { message: string } }).error.message;
    return msg !== 'No such route.';
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const LOOPBACK = ['127.0.0.1', '::1', '[::1]', 'localhost', 'LOCALHOST', 'LocalHost', 'localhost.', 'LOCALHOST.'];
const NOT_LOOPBACK = [
  '0.0.0.0', '', '::', '[::]', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', 'localhost.evil.com', 'localhost.localdomain', 'evil-localhost', 'xlocalhost', 'localhost..', '127.0.0.1.',
  '127.0.0.2', '127.0.0.1:3000', ' 127.0.0.1', '127.0.0.1 ', 'localhost\0', '[localhost]', '[127.0.0.1]', '[[::1]]', '::1.', '0:0:0:0:0:0:0:1', '127.1', '2130706433', 'example.com', '192.168.1.5', 'localhost@evil.com', 'localhost/',
];

describe('isLoopbackHost', () => {
  it.each(LOOPBACK)('%j is loopback', (h) => expect(isLoopbackHost(h)).toBe(true));
  it.each(NOT_LOOPBACK)('%j is not loopback', (h) => expect(isLoopbackHost(h)).toBe(false));
});

describe('isLoopbackAddress (the address the socket really got)', () => {
  it.each(['127.0.0.1', '127.9.9.9', '::1'])('%s is loopback', (a) => expect(isLoopbackAddress(a)).toBe(true));
  it.each(['0.0.0.0', '::', '192.168.1.5', '::ffff:127.0.0.1', '1127.0.0.1', '127.0.0.1.5', '8.8.8.8', ''])('%j is not', (a) => expect(isLoopbackAddress(a)).toBe(false));
});

describe('student routes are mounted only for a loopback bind host (decision 0018, amended in 0028)', () => {
  it.each(LOOPBACK)('flag on + %j: allowed, routes mounted', async (host) => {
    expect(await studentRouteMounted(createApp(deps(true, host)))).toBe(true);
  });

  it.each(NOT_LOOPBACK)('flag on + %j: createApp refuses to start and the message names the variable and the host', (host) => {
    expect(() => createApp(deps(true, host))).toThrow(/^STUDENT_ROUTES_ENABLED=true is allowed only when the server binds to a loopback host/);
    expect(() => createApp(deps(true, host))).toThrow(/the bind host is /);
  });

  it.each([...LOOPBACK, ...NOT_LOOPBACK])('flag off + %j: no check, routes absent (404)', async (host) => {
    expect(await studentRouteMounted(createApp(deps(false, host)))).toBe(false);
  });

  it('startServer fails before listening, and never prints credentials or odd characters', async () => {
    await expect(startServer(deps(true, '0.0.0.0'))).rejects.toThrow('the bind host is "0.0.0.0"');
    expect(() => assertStudentRoutesAllowed(true, 'user:pass@evil.com/x?token=abc')).toThrow(/<unprintable>/);
    expect(() => assertStudentRoutesAllowed(true, 'user:pass@evil.com/x?token=abc')).not.toThrow(/pass|token/);
  });

  it('startServer accepts [::1] and localhost with the flag on (the socket address is checked after listen)', async () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const s = await startServer(deps(true, host)).catch((e: NodeJS.ErrnoException) => e);
      if (s instanceof Error) {
        expect((s as NodeJS.ErrnoException).code, `${host}: ${s.message}`).toBe('EADDRNOTAVAIL'); // a machine without IPv6
        continue;
      }
      await s.close();
    }
  });

  it('startServer on 127.0.0.1 with the flag on serves the student route', async () => {
    const s = await startServer(deps(true, '127.0.0.1'));
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/users/00000000-0000-4000-8000-000000000000/courses`);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe('User not found.');
    } finally {
      await s.close();
    }
  });

  it('the student router is imported by app.ts only, and only createApp mounts it', () => {
    const dir = new URL('./', import.meta.url);
    const users = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && readFileSync(new URL(f, dir), 'utf8').includes('student.js'));
    expect(users).toEqual(['app.ts']);
    const app = readFileSync(new URL('app.ts', dir), 'utf8');
    expect(app.match(/studentRouter\(/g)).toHaveLength(1);
    expect(app.indexOf('assertStudentRoutesAllowed(')).toBeLessThan(app.indexOf('studentRouter('));
  });
});
