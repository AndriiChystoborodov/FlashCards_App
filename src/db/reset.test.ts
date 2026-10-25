import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertResettable, RESET_TEST_DATABASE, resetDatabase } from './reset.js';

const base = 'postgres://retain:retain@localhost:5433';
const dev = `${base}/retain_dev`;

describe('assertResettable', () => {
  it.each([
    ['retain_dev on localhost', dev, 'localhost'],
    ['retain_dev on 127.0.0.1', 'postgres://u:p@127.0.0.1:5433/retain_dev', '127.0.0.1'],
    ['the reset test database', `${base}/${RESET_TEST_DATABASE}`, 'localhost'],
    // pg decodes %5F to "_" too, so the name it connects to is the one that was checked
    ['an encoded underscore in the name', `${base}/retain%5Fdev`, 'localhost'],
  ])('accepts %s', (_label, url, host) => {
    expect(assertResettable(url).hostname).toBe(host);
  });

  const name = /one of "retain_dev", "retain_reset_test"/;
  const host = /localhost or 127\.0\.0\.1/;
  it.each([
    ['the test database', `${base}/retain_test`, name],
    ['a name that only starts with an allowed one', `${base}/retain_dev2`, name],
    ['an uppercase database name', `${base}/RETAIN_DEV`, name],
    ['the maintenance database', `${base}/postgres`, name],
    ['no database name', base, name],
    ['a trailing slash after the name', `${base}/retain_dev/`, name],
    ['a remote host', 'postgres://retain:retain@db.example.com:5432/retain_dev', host],
    ['a lookalike host', 'postgres://retain:retain@localhost.example.com/retain_dev', host],
    ['an uppercase host', 'postgres://retain:retain@LOCALHOST:5433/retain_dev', host],
    ['a trailing dot after the host', 'postgres://retain:retain@localhost.:5433/retain_dev', host],
    ['comma-separated hosts', 'postgres://retain:retain@localhost,db.example.com:5433/retain_dev', host],
    ['the IPv6 loopback', 'postgres://retain:retain@[::1]:5433/retain_dev', host],
    ['an empty host (unix socket)', 'postgres:///retain_dev', host],
    ['query parameters that could override host or database', `${dev}?host=db.example.com`, /query parameters/],
    ['a string that is not a URL', 'not a url', /not a valid URL/],
  ])('refuses %s', (_label, url, message) => {
    expect(() => assertResettable(url)).toThrow(message);
  });
});

// Needs the local Docker database. It only ever touches retain_reset_test, which it creates and drops itself.
describe('resetDatabase', () => {
  const testUrl = process.env.TEST_DATABASE_URL;
  const resetUrl = (() => {
    if (!testUrl) return '';
    const u = new URL(testUrl);
    u.pathname = `/${RESET_TEST_DATABASE}`;
    return u.toString();
  })();
  const admin = (() => {
    const u = new URL(testUrl ?? 'postgres://x@localhost/x');
    u.pathname = '/postgres';
    return u.toString();
  })();

  afterAll(async () => {
    if (!testUrl) return;
    const client = new pg.Client({ connectionString: admin });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS ${RESET_TEST_DATABASE} WITH (FORCE)`);
    } finally {
      await client.end();
    }
  });

  it('refuses before connecting when the target is not allowed', async () => {
    await expect(resetDatabase('postgres://retain:retain@localhost:1/retain_test')).rejects.toThrow(/retain_dev/);
  });

  it('creates the database, leaves it empty and migrated, and works twice', async () => {
    if (!testUrl) throw new Error('TEST_DATABASE_URL is not set. Start the test database (npm run db:up) and set it as in .env.example.');
    expect(new URL(resetUrl).pathname).toBe(`/${RESET_TEST_DATABASE}`);
    await resetDatabase(resetUrl);
    const pool = new pg.Pool({ connectionString: resetUrl });
    try {
      await pool.query("INSERT INTO users (full_name, email, role) VALUES ('T', 'reset@x.test', 'teacher')");
      await resetDatabase(resetUrl); // second run must also succeed and wipe the row
      const tables = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
      expect(tables.rows[0]?.n).toBe(6);
      const users = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
      expect(users.rows[0]?.n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
