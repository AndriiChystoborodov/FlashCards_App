import assert from 'node:assert/strict';
import { createControlledClock } from '../src/clock.js';
import { env } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import { resetDatabase } from '../src/db/reset.js';

// End-to-end scenario (docs/scenario.md). Each task adds steps; a failed step stops the run.
const url = env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set.');

const TABLES = ['card_states', 'courses', 'enrollments', 'flashcards', 'reviews', 'users'];
const clock = createControlledClock(new Date('2026-01-12T10:00:00Z')); // Monday 10:00, walkthrough section 1

interface Step {
  name: string;
  run: () => Promise<void>;
}

const steps: Step[] = [
  { name: 'reset: database rebuilt and migrated', run: () => resetDatabase(url) },
  {
    name: 'schema: all six tables exist and are empty',
    run: async () => {
      const { pool } = createDb(url);
      try {
        const tables = await pool.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
        );
        assert.deepEqual(tables.rows.map((r) => r.table_name), TABLES);
        for (const t of TABLES) {
          const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`);
          assert.equal(n.rows[0]?.n, 0, `table ${t} is not empty`);
        }
      } finally {
        await pool.end();
      }
    },
  },
  {
    name: 'clock: advances by days',
    run: async () => {
      clock.advanceDays(2);
      assert.equal(clock.now().toISOString(), '2026-01-14T10:00:00.000Z');
    },
  },
];

// Walkthrough sections that need later tasks (docs/scenario.md). Listed, not run.
const pending = [
  '1 teacher sets up (create_course, add_flashcards, enroll_students, start_course): Tasks 7, 9',
  '2 assessment answers through the answer service: Task 5',
  '3 normal mode, daily tick, clamp and learned: Tasks 5, 6',
  '4 progress: Task 7',
  '5 stop_course: Task 7',
  '6 edge cases (double click, reminders, added card): Tasks 5, 6',
];

for (const [i, step] of steps.entries()) {
  try {
    await step.run();
    console.log(`ok   ${i + 1} ${step.name}`);
  } catch (err) {
    console.error(`FAIL ${i + 1} ${step.name}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
for (const p of pending) console.log(`pending ${p}`);
