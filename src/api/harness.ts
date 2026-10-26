import { randomUUID } from 'node:crypto';
import { createControlledClock } from '../clock.js';
import { db } from '../db/testDb.js';
import { issueTeacherToken } from '../services/auth.js';
import { FakeSlack } from '../slack/fake.js';
import { createApp } from './app.js';
import { listen } from './testClient.js';

/** Test helper: the app on a random 127.0.0.1 port over the test database, a controlled clock and a FakeSlack. Ids and emails are random, so test files can share the database. */
export async function harness(opts: { studentRoutes?: boolean } = {}) {
  const clock = createControlledClock(new Date('2026-01-05T09:00:00Z')); // Monday 10:00 Zurich
  const slack = new FakeSlack();
  const deps = { db, clock, tenantTimezone: 'Europe/Zurich', slack };
  const api = await listen(createApp({ ...deps, removedRetentionDays: 14, studentRoutesEnabled: opts.studentRoutes ?? false }));
  const tag = randomUUID().slice(0, 8);
  let n = 0;
  const email = (who: string) => `${who}-${tag}-${(n += 1)}@x.test`;
  return {
    api, clock, slack, deps, email,
    teacher: async () => issueTeacherToken(db, { email: email('teacher'), fullName: 'Tom' }),
    /** A student the fake Slack knows (`slack_matched` true). */
    matched(who: string) {
      const e = email(who);
      slack.directory.set(e, { slackId: `U-${randomUUID().slice(0, 8)}`, tz: 'Europe/Zurich' });
      return e;
    },
  };
}

export const courseBody = (over: Record<string, unknown> = {}) => ({ title: 'Security basics', material_url: 'https://x.test/m', ends_at: '2026-01-16T22:59:00Z', ...over });
export const cardBody = (over: Record<string, unknown> = {}) => ({ question: 'Q', options: ['right', 'x', 'y'], correct_option: 0, is_assessment: false, ...over });

export type Harness = Awaited<ReturnType<typeof harness>>;

/** A draft course with `cards` cards, the first `assessment` of them assessment cards. */
export async function draftCourse(h: Harness, token: string, cards = 4, assessment = 1) {
  const c = await h.api.call(token, 'POST', '/courses', courseBody());
  const courseId: string = c.body.course_id;
  const r = await h.api.call(token, 'POST', `/courses/${courseId}/flashcards`, {
    flashcards: Array.from({ length: cards }, (_, i) => cardBody({ question: `Q${i + 1}`, is_assessment: i < assessment })),
  });
  return { courseId, cardIds: (r.body.flashcards as { flashcard_id: string }[]).map((f) => f.flashcard_id) };
}
