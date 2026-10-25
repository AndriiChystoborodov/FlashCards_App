import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertResettable, resetDatabase } from './reset.js';

const dev = 'postgres://retain:retain@localhost:5433/retain_dev';

describe('assertResettable', () => {
  it('accepts localhost and 127.0.0.1 with retain_dev', () => {
    expect(assertResettable(dev).hostname).toBe('localhost');
    expect(assertResettable('postgres://u:p@127.0.0.1:5433/retain_dev').hostname).toBe('127.0.0.1');
  });

  it.each([
    ['the test database', 'postgres://retain:retain@localhost:5433/retain_test', /retain_dev/],
    ['a name that only starts with retain_dev', 'postgres://retain:retain@localhost:5433/retain_dev2', /retain_dev/],
    ['the maintenance database', 'postgres://retain:retain@localhost:5433/postgres', /retain_dev/],
    ['no database name', 'postgres://retain:retain@localhost:5433', /retain_dev/],
    ['a remote host', 'postgres://retain:retain@db.example.com:5432/retain_dev', /localhost or 127\.0\.0\.1/],
    ['a lookalike host', 'postgres://retain:retain@localhost.example.com/retain_dev', /localhost or 127\.0\.0\.1/],
    ['query parameters that could override host or database', `${dev}?host=db.example.com`, /query parameters/],
    ['a string that is not a URL', 'not a url', /not a valid URL/],
  ])('refuses %s', (_label, url, message) => {
    expect(() => assertResettable(url)).toThrow(message);
  });
});

// Needs the local Docker database; derives the dev URL from TEST_DATABASE_URL so host and port match.
describe('resetDatabase', () => {
  it('refuses before connecting when the target is not retain_dev', async () => {
    await expect(resetDatabase('postgres://retain:retain@localhost:1/retain_test')).rejects.toThrow(/retain_dev/);
  });

  it('creates retain_dev, leaves it empty and migrated, and works twice', async () => {
    const testUrl = process.env.TEST_DATABASE_URL;
    if (!testUrl) throw new Error('TEST_DATABASE_URL is not set. Start the test database (npm run db:up) and set it as in .env.example.');
    const u = new URL(testUrl);
    u.pathname = '/retain_dev';
    await resetDatabase(u.toString());
    const pool = new pg.Pool({ connectionString: u.toString() });
    try {
      await pool.query("INSERT INTO users (full_name, email, role) VALUES ('T', 'reset@x.test', 'teacher')");
      await resetDatabase(u.toString()); // second run must also succeed and wipe the row
      const tables = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
      expect(tables.rows[0].n).toBe(6);
      const users = await pool.query('SELECT count(*)::int AS n FROM users');
      expect(users.rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
