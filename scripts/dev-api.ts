import { systemClock } from '../src/clock.js';
import { env } from '../src/config/env.js';
import { createApp } from '../src/api/app.js';
import { createDb } from '../src/db/client.js';
import type { CardMessage } from '../src/slack/card.js';
import type { SlackPort } from '../src/slack/port.js';

// `npm run api`: the REST API for trying routes with curl (docs/rest-api.md "Try it with curl"). Development only:
// 127.0.0.1 only, Slack messages are printed to the console, there is no tick. Task 8 wires the real server in src/index.ts.
if (env.NODE_ENV === 'production') throw new Error('npm run api is for development only.');
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');

let n = 0;
const log = (what: string, to: string, m: CardMessage) => console.log(`[slack ${what}] ${to}: ${m.text}`);
const consoleSlack: SlackPort = {
  async postCard(to, message) {
    log('post', to, message);
    return { channel: to.startsWith('D') ? to : `D-${to}`, ts: `${(n += 1)}.000100` };
  },
  async replaceMessage(channel, ts, message) {
    log('replace', `${channel} ${ts}`, message);
  },
  async lookupEmail() {
    return null; // nobody is matched without a real workspace
  },
};

const { db } = createDb(env.DATABASE_URL);
const app = createApp({
  db, clock: systemClock, tenantTimezone: env.TENANT_TIMEZONE, slack: consoleSlack,
  removedRetentionDays: env.REMOVED_RETENTION_DAYS, studentRoutesEnabled: env.STUDENT_ROUTES_ENABLED,
});
const port = Number(process.env.PORT ?? 3000);
app.listen(port, '127.0.0.1', () => console.log(`Retain API on http://127.0.0.1:${port}`));
