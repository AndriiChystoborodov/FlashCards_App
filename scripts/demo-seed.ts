import { webApi } from '@slack/bolt';
import { systemClock } from '../src/clock.js';
import { env } from '../src/config/env.js';
import { startServer } from '../src/api/server.js';
import { createDb } from '../src/db/client.js';
import { assertDemoDatabase } from '../src/db/reset.js';
import { issueTeacherToken } from '../src/services/auth.js';
import { slackPort } from '../src/slack/web.js';

// Usage: npm run demo:seed -- <slack-email> [days]
// A demo course for the real Slack workspace (docs/slack/live-run.md). Local development database only.
const [email, daysArg] = process.argv.slice(2);
const days = daysArg === undefined ? 3 : Number(daysArg);
if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || !Number.isInteger(days) || days < 1 || days > 60) {
  console.error('Usage: npm run demo:seed -- <slack-email> [days 1-60, default 3]');
  process.exit(1);
}
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
assertDemoDatabase(env.DATABASE_URL); // before anything else: no token is issued and nothing is sent on another database

const TITLE = 'Demo: Security basics';
const CARDS: { question: string; options: string[]; correct: number; assessment: boolean }[] = [
  { question: 'What should you do with an email from an unknown sender that asks you to log in urgently?', options: ['Click the link and log in', 'Report it to the security team', 'Forward it to colleagues'], correct: 1, assessment: true },
  { question: 'Which password is the strongest?', options: ['Summer2024!', 'correct-horse-battery-staple-91', 'qwerty123'], correct: 1, assessment: true },
  { question: 'What does two-factor authentication add?', options: ['A second proof of identity', 'A longer password', 'A faster login'], correct: 0, assessment: true },
  { question: 'Where is it safe to store a shared password?', options: ['A sticky note on the monitor', 'The company password manager', 'The team chat'], correct: 1, assessment: false },
  { question: 'A USB stick lies in the car park. What do you do?', options: ['Plug it in to find the owner', 'Hand it to IT without plugging it in', 'Take it home'], correct: 1, assessment: false },
  { question: 'How soon should a lost company laptop be reported?', options: ['Immediately', 'At the end of the week', 'Only if it had data'], correct: 0, assessment: false },
  { question: 'What is phishing?', options: ['Fraud that imitates a trusted sender', 'A network speed test', 'A backup method'], correct: 0, assessment: false },
  { question: 'Public Wi-Fi at a cafe: which is the safest way to work?', options: ['Without any protection', 'Through the company VPN', 'Only on websites with a logo'], correct: 1, assessment: false },
  { question: 'Что нужно сделать, если вы получили подозрительное письмо от неизвестного отправителя?', options: ['Удалить без ответа', 'Сообщить в службу безопасности', 'Переслать коллегам'], correct: 1, assessment: false },
  { question: 'Who may you give your password to?', options: ['IT support, when they call you', 'A manager who asks nicely', 'Nobody'], correct: 2, assessment: false },
];

const { db, pool } = createDb(env.DATABASE_URL);
const web = new webApi.WebClient(env.SLACK_BOT_TOKEN, { retryConfig: webApi.retryPolicies.fiveRetriesInFiveMinutes, timeout: 15_000 });
// In-process API like scripts/scenario.ts: REST on a random loopback port, the real Slack adapter, no tick and no Bolt (posting needs no socket).
const server = await startServer(
  { db, clock: systemClock, tenantTimezone: env.TENANT_TIMEZONE, slack: slackPort(web), removedRetentionDays: env.REMOVED_RETENTION_DAYS, studentRoutesEnabled: false, bindHost: '127.0.0.1' },
  0,
);
try {
  const token = await issueTeacherToken(db, { email: 'demo-teacher@retain.local', fullName: 'Demo Teacher' });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json = res.status === 204 ? null : await res.json();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${(json as { error?: { code?: string } }).error?.code ?? ''}`);
    return json;
  };

  const existing = ((await call('GET', '/courses')) as { courses: { course_id: string; title: string; status: string }[] }).courses.find((c) => c.title === TITLE);
  if (existing?.status === 'finished') throw new Error(`The demo course is finished. Run npm run db:reset (stop npm run dev first) and seed again.`);
  let courseId = existing?.course_id;
  if (!courseId) {
    const course = (await call('POST', '/courses', { title: TITLE, material_url: 'https://example.com/security-basics', ends_at: new Date(Date.now() + days * 86_400_000).toISOString() })) as { course_id: string };
    courseId = course.course_id;
    await call('POST', `/courses/${courseId}/flashcards`, {
      flashcards: CARDS.map((c) => ({ question: c.question, options: c.options, correct_option: c.correct, is_assessment: c.assessment })),
    });
  }
  const enrolled = (await call('POST', `/courses/${courseId}/students`, { students: [{ email, name: email.split('@')[0] }] })) as { students: { enrolled: boolean; slack_matched: boolean }[] };
  const s = enrolled.students[0]!;
  if (!existing || existing.status === 'draft') await call('POST', `/courses/${courseId}/start`);

  console.log(existing ? `Demo course reused (${existing.status}).` : `Demo course created: ${CARDS.length} cards, ${CARDS.filter((c) => c.assessment).length} assessment, ends in ${days} day(s).`);
  console.log(`Teacher token (shown once; a new run replaces it): ${token}`);
  if (!s.slack_matched) {
    console.log(`Slack does not know that email, so the student is enrolled but gets no card. Check the address (it must be the one of the Slack account) and run again with the right one.`);
  } else if (!s.enrolled) {
    console.log('That email was already enrolled; the next tick sends the next card.');
  } else {
    console.log('The first card is on its way to your Slack DM.');
  }
} finally {
  await server.close();
  await pool.end();
}
