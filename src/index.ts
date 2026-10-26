import { systemClock } from './clock.js';
import { startServer } from './api/server.js';
import { env } from './config/env.js';
import { createDb } from './db/client.js';
import type { SchedulerDeps } from './services/scheduler.js';
import { errText } from './services/logError.js';
import { startTick } from './services/tick.js';
import { createSlack } from './slack/start.js';

if (env.SLACK_MODE !== 'socket') throw new Error('SLACK_MODE=http is not built yet (Task 8 supports socket mode only).');
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
if (!env.SLACK_APP_TOKEN) throw new Error('SLACK_APP_TOKEN is not set.'); // the env schema checks it too; this narrows the type

const { db, pool } = createDb(env.DATABASE_URL);
const slack = createSlack({ botToken: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN });
const deps: SchedulerDeps = { db, clock: systemClock, tenantTimezone: env.TENANT_TIMEZONE, slack: slack.port };

// The server first: `startServer` is the single place that refuses the student routes off loopback, so a bad HOST fails before Slack connects.
const server = await startServer(
  { ...deps, removedRetentionDays: env.REMOVED_RETENTION_DAYS, studentRoutesEnabled: env.STUDENT_ROUTES_ENABLED, bindHost: env.HOST },
  env.PORT,
);
let tick: ReturnType<typeof startTick> | undefined;
let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(1), 10_000).unref(); // a stuck step must not keep the process alive
  // Each step is tried even when an earlier one fails; the error is logged by name only (driver errors carry query parameters).
  for (const step of [() => tick?.stop(), () => slack.stop(), () => server.close(), () => pool.end()]) {
    try {
      await step();
    } catch (err) {
      code = 1;
      console.error('shutdown step failed', errText(err));
    }
  }
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

try {
  slack.handle(deps);
  await slack.start();
  tick = startTick(deps, { sendHour: env.SEND_HOUR, intervalMs: env.TICK_MINUTES * 60_000 });
  console.log(`Retain running: REST on http://${server.host}:${server.port}, Slack socket mode, tick every ${env.TICK_MINUTES} min from ${env.SEND_HOUR}:00 local.`);
} catch (err) {
  console.error('startup failed', errText(err));
  await shutdown(1);
}
