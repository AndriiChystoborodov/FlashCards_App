import { pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDb } from './client.js';

export const DEV_DATABASE = 'retain_dev';
/** Throwaway database of the reset test, so the test never touches retain_dev (decision 0024). */
export const RESET_TEST_DATABASE = 'retain_reset_test';
const RESETTABLE = [DEV_DATABASE, RESET_TEST_DATABASE];
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/** Decision 0024: the reset only ever touches the local development database. */
export function assertResettable(connectionString: string): URL {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('Refusing to reset: DATABASE_URL is not a valid URL.');
  }
  // pg-connection-string lets query parameters (?host=, ?database=) override the URL parts checked here.
  if (url.search) throw new Error('Refusing to reset: DATABASE_URL must not have query parameters.');
  if (!LOCAL_HOSTS.includes(url.hostname)) {
    throw new Error(`Refusing to reset: host must be localhost or 127.0.0.1, got "${url.hostname}".`);
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!RESETTABLE.includes(name)) {
    throw new Error(`Refusing to reset: database name must be exactly one of ${RESETTABLE.map((n) => `"${n}"`).join(', ')}, got "${name}".`);
  }
  return url;
}

/** `npm run demo:seed` writes a demo course and sends real Slack messages, so it runs only against `retain_dev` (not the reset test's database). Same checks as the reset, then the exact name. */
export function assertDemoDatabase(connectionString: string): void {
  const url = assertResettable(connectionString);
  if (decodeURIComponent(url.pathname.slice(1)) !== DEV_DATABASE) throw new Error(`Refusing to seed: the database must be exactly "${DEV_DATABASE}".`);
}

// The compose init scripts only run on the first volume init, so the database is created here (name already checked by the guard).
async function ensureDatabase(url: URL, name: string): Promise<void> {
  const admin = new URL(url.toString());
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount === 0) await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
}

/** Drops everything in the target database (creating it first if missing) and applies the committed migrations. */
export async function resetDatabase(connectionString: string): Promise<void> {
  const url = assertResettable(connectionString);
  await ensureDatabase(url, decodeURIComponent(url.pathname.slice(1)));
  const { db, pool } = createDb(connectionString);
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(db, { migrationsFolder: 'drizzle' });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { env } = await import('../config/env.js');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  await resetDatabase(env.DATABASE_URL);
  console.log(`Database ${new URL(env.DATABASE_URL).pathname.slice(1)} reset and migrated.`);
}
