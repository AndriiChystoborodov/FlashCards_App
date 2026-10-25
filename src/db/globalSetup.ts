import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

// Applies the committed migrations to the test database once per run. Without TEST_DATABASE_URL only the DB tests fail (testDb.ts says why).
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const { db, pool } = createDb(url);
  try {
    await migrate(db, { migrationsFolder: 'drizzle' });
  } finally {
    await pool.end();
  }
}
