import { env } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import { issueTeacherToken } from '../src/services/auth.js';

// Usage: npm run teacher:token -- teacher@example.com "Teacher Name"
// Creates the teacher if needed and prints a new token once (the old one stops working). Only its SHA-256 hash is stored (decision 0014).
const [email, ...name] = process.argv.slice(2);
if (!email || name.length === 0) {
  console.error('Usage: npm run teacher:token -- <email> "<full name>"');
  process.exit(1);
}
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
const { db, pool } = createDb(env.DATABASE_URL);
try {
  console.log(await issueTeacherToken(db, { email, fullName: name.join(' ') }));
} finally {
  await pool.end();
}
