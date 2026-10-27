import type { Clock } from '../clock.js';
import { claimCard, setCardMessage } from '../db/cardStates.js';
import type { Db, Tx } from '../db/client.js';
import { getFlashcard } from '../db/flashcards.js';
import { finishCourse as markCourseFinished, getCourse, listEndedCourseIds } from '../db/courses.js';
import { completeAssessment, completeEnrollment, listPresentEnrollments, lockEnrollment } from '../db/enrollments.js';
import {
  countAssessmentCards, countCards, countIntroducedBetween, countLearned, countUnsentNormalCards, getOpenCard, nextDueCard, nextUnsentCard,
  type Flashcard,
} from '../db/selection.js';
import type { users } from '../db/schema.js';
import { getUser, setDmChannel } from '../db/users.js';
import { endOfLocalDay, localDaysThrough, startOfLocalDayOf } from '../domain/localDay.js';
import { quotaToday } from '../domain/quota.js';
import { renderCard } from '../render/card.js';
import { buildCardMessage, textOnly } from '../slack/card.js';
import { CardImageError, type CardImage, type SlackPort } from '../slack/port.js';
import type { AnswerResult } from './answer.js';
import { errText } from './logError.js';
import { studentTimezone } from './timezone.js';

export interface SchedulerDeps {
  db: Db;
  clock: Clock;
  tenantTimezone: string;
  slack: SlackPort;
}

export type NextCard = { card: Flashcard; kind: 'assessment' | 'due' | 'new' };
export type SendResult = { status: 'sent'; flashcardId: string; kind: NextCard['kind']; channel: string; ts: string } | { status: 'none' };

type User = typeof users.$inferSelect;

export const TEXT = {
  exempt: 'You already know this material, so there are no more cards for this course.',
  completed: 'Congratulations, you have learned every card of this course.',
  ended: (progress: number) => `The course has ended. Your final progress is ${Math.round(progress)}%.`,
  expired: 'The course is over.',
  started: 'A new course has started for you. Your first card follows.',
  restored: 'You are enrolled in this course again. Your progress is kept.',
  removed: 'expired',
};

/**
 * scheduler.md "Selecting the next card", after the guards. Reads in the caller's transaction; the one write is the
 * zero-assessment completion (`assessment_done_at`, no score), which the same call continues from.
 */
async function pick(tx: Tx, now: Date, userId: string, courseId: string, assessmentDone: boolean, tz: string): Promise<NextCard | null> {
  if (!assessmentDone) {
    const a = await nextUnsentCard(tx, userId, courseId, true);
    if (a) return { card: a, kind: 'assessment' };
    // Every assessment card was sent: submitAnswer evaluates after the last answer, so there is nothing to pick yet.
    if ((await countAssessmentCards(tx, courseId)) > 0) return null;
    await completeAssessment(tx, courseId, userId, { doneAt: now, score: null, status: 'active' });
  }
  const due = await nextDueCard(tx, userId, courseId, endOfLocalDay(tz, now));
  if (due) return { card: due, kind: 'due' };

  const remainingNew = await countUnsentNormalCards(tx, userId, courseId);
  if (remainingNew === 0) return null;
  const course = await getCourse(tx, courseId);
  const introducedToday = await countIntroducedBetween(tx, userId, courseId, startOfLocalDayOf(tz, now), endOfLocalDay(tz, now));
  const quota = quotaToday(remainingNew, introducedToday, localDaysThrough(tz, now, new Date(course!.endsAt.getTime() - 1)));
  if (introducedToday >= quota) return null;
  const card = await nextUnsentCard(tx, userId, courseId, false);
  return card ? { card, kind: 'new' } : null;
}

/** The guards and the selection under the enrollment lock. `claim` opens the chosen card in the same transaction. */
async function selectAndMaybeClaim(deps: SchedulerDeps, userId: string, courseId: string, claim: boolean): Promise<{ next: NextCard; user: User } | null> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const enrollment = await lockEnrollment(tx, courseId, userId);
    if (!enrollment || enrollment.removedAt || enrollment.status !== 'active') return null;
    const course = await getCourse(tx, courseId);
    if (!course || course.status !== 'active' || now >= course.endsAt) return null;
    const user = await getUser(tx, userId);
    if (!user || (claim && !user.slackId)) return null;
    if (await getOpenCard(tx, userId, courseId)) return null;

    const tz = studentTimezone(user, deps.tenantTimezone);
    const next = await pick(tx, now, userId, courseId, enrollment.assessmentDoneAt !== null, tz);
    if (!next) return null;
    if (claim && !(await claimCard(tx, userId, next.card.id, now))) return null;
    return { next, user };
  });
}

/** The card the student would get now, or null. Does not open it. */
export async function next(deps: SchedulerDeps, userId: string, courseId: string): Promise<NextCard | null> {
  return (await selectAndMaybeClaim(deps, userId, courseId, false))?.next ?? null;
}

/**
 * Picks the next card, opens it (one transaction under the enrollment lock) and posts it. Used at course start, at enrollment,
 * after every answer and by the daily tick. A Slack failure leaves the card open without a `message_ts` (6b-2 re-sends it).
 */
export async function sendNext(deps: SchedulerDeps, userId: string, courseId: string): Promise<SendResult> {
  const claimed = await selectAndMaybeClaim(deps, userId, courseId, true);
  if (!claimed) return { status: 'none' };
  const { next: n, user } = claimed;
  const { channel, ts } = await postCard(deps, user, n.card);
  return { status: 'sent', flashcardId: n.card.id, kind: n.kind, channel, ts };
}

/**
 * The question as an image (decision 0034), rendered per delivery (no cache, no stored file id). Null with a short logged code when
 * the question cannot be drawn: the card is then sent as text, so a claimed card is never retried forever.
 */
const errName = (e: unknown) => (e instanceof Error ? e.name : 'unknown');

function imageOf(card: Flashcard): CardImage | null {
  let r: ReturnType<typeof renderCard>;
  try {
    r = renderCard(card.question);
  } catch (err) {
    console.warn(`card ${card.id}: no image (render_threw ${errName(err)}), sent as text`); // a missing font or a native failure must not keep a claim failing
    return null;
  }
  if (!r.ok) {
    console.warn(`card ${card.id}: no image (${r.code}), sent as text`);
    return null;
  }
  return { png: r.png, width: r.width, height: r.height, alt: r.text };
}

/**
 * Posts the card (image first, text card when the image is unavailable: render error, upload failure, Slack never accepted the
 * block), records `message_channel`/`message_ts` and caches the DM channel. Shared by the send and the stale-claim re-send (and
 * the reminders of 6b-2). Any other Slack error propagates: the claim stays and the tick re-posts it (decision 0027).
 */
async function postCard(deps: SchedulerDeps, user: User, card: Flashcard, sentAt?: Date): Promise<{ channel: string; ts: string }> {
  const to = user.slackDmChannel ?? user.slackId!;
  const image = imageOf(card);
  let posted: { channel: string; ts: string } | undefined;
  if (image) {
    try {
      posted = await deps.slack.postCard(to, buildCardMessage(card, { imageAbove: true }), image);
    } catch (err) {
      if (!(err instanceof CardImageError)) throw err;
      console.warn(`card ${card.id}: image unavailable (${err.code}), sent as text`);
    }
  }
  const { channel, ts } = posted ?? (await deps.slack.postCard(to, buildCardMessage(card)));
  await setCardMessage(deps.db, user.id, card.id, channel, ts, sentAt);
  if (!user.slackDmChannel) await setDmChannel(deps.db, user.id, channel);
  return { channel, ts };
}

/**
 * Stale-claim recovery (scheduler.md "Idempotent send"): a card claimed `staleMs` ago or more whose post never got recorded
 * (`message_ts` null) is posted again. `sent_at` does not change: it is the same delivery. Returns true when it re-posted.
 */
export async function resendStaleClaim(
  deps: SchedulerDeps,
  userId: string,
  courseId: string,
  staleMs: number,
  openCard?: Awaited<ReturnType<typeof getOpenCard>>,
): Promise<boolean> {
  const open = openCard === undefined ? await getOpenCard(deps.db, userId, courseId) : openCard;
  const now = deps.clock.now();
  if (!open || open.messageTs || !open.sentAt || now.getTime() - open.sentAt.getTime() < staleMs) return false;
  const [user, card, course] = await Promise.all([getUser(deps.db, userId), getFlashcard(deps.db, open.flashcardId), getCourse(deps.db, courseId)]);
  if (!user?.slackId || !card || !course || course.status !== 'active' || now >= course.endsAt) return false;
  await postCard(deps, user, card, open.sentAt);
  return true;
}

/** Course start: the first assessment card to every present active student, one after another. */
export async function sendFirstCards(deps: SchedulerDeps, courseId: string): Promise<number> {
  let sent = 0;
  for (const e of await listPresentEnrollments(deps.db, courseId)) {
    if (e.status !== 'active') continue;
    try {
      if ((await sendNext(deps, e.userId, courseId)).status === 'sent') sent += 1;
    } catch (err) {
      console.error(`first card for user ${e.userId} failed`, errText(err));
    }
  }
  return sent;
}

export async function dm(deps: SchedulerDeps, userId: string, text: string): Promise<void> {
  const user = await getUser(deps.db, userId);
  const to = user?.slackDmChannel ?? user?.slackId;
  if (to) await deps.slack.postCard(to, textOnly(text));
}

/** Progress as the teacher sees it: learned cards over all cards of the course. */
const progressOf = async (db: Db | Tx, userId: string, courseId: string): Promise<number> => {
  const total = await countCards(db, courseId);
  return total === 0 ? 0 : ((await countLearned(db, userId, courseId)) / total) * 100;
};

/** S16: `active` becomes `completed` once, when every card of the course is learned; sends the congratulation. */
export async function completeIfLearned(deps: SchedulerDeps, userId: string, courseId: string): Promise<boolean> {
  const now = deps.clock.now();
  const done = await deps.db.transaction(async (tx) => {
    const enrollment = await lockEnrollment(tx, courseId, userId);
    if (!enrollment || enrollment.removedAt || enrollment.status !== 'active') return false;
    const total = await countCards(tx, courseId);
    if (total === 0 || (await countLearned(tx, userId, courseId)) !== total) return false;
    return completeEnrollment(tx, courseId, userId, { at: now, progress: 100 });
  });
  if (done) await dm(deps, userId, TEXT.completed);
  return done;
}

/**
 * What follows an answer (scheduler.md "Answer path", steps 4 and 5): the exempt message, completion on the last learned
 * card, then the next card with no `SEND_HOUR` gate. Does nothing for a rejected or duplicate answer.
 */
export async function afterAnswer(deps: SchedulerDeps, userId: string, courseId: string, result: AnswerResult): Promise<SendResult> {
  if (result.status !== 'answered') return { status: 'none' };
  if (result.assessment?.exempt) {
    await dm(deps, userId, TEXT.exempt);
    return { status: 'none' };
  }
  if (await completeIfLearned(deps, userId, courseId)) return { status: 'none' };
  return sendNext(deps, userId, courseId);
}

/**
 * Ends the course (decision 0011): every present `active` enrollment becomes `completed` with its progress frozen, the course
 * becomes `finished`, students get the final progress and an open card's message is replaced. `exempt` and removed
 * enrollments are left alone. The tick (6b-1) calls `finishEndedCourses`; stop (Task 7) calls this.
 */
export async function finishCourse(deps: SchedulerDeps, courseId: string): Promise<{ completed: string[] }> {
  const now = deps.clock.now();
  const { completed, open } = await deps.db.transaction(async (tx) => {
    if (!(await markCourseFinished(tx, courseId))) return { completed: [] as { userId: string; progress: number }[], open: [] as { channel: string; ts: string }[] };
    const completed: { userId: string; progress: number }[] = [];
    const open: { channel: string; ts: string }[] = [];
    for (const e of await listPresentEnrollments(tx, courseId)) {
      if (e.status !== 'active') continue;
      const progress = await progressOf(tx, e.userId, courseId);
      if (!(await completeEnrollment(tx, courseId, e.userId, { at: now, progress }))) continue;
      completed.push({ userId: e.userId, progress });
      const card = await getOpenCard(tx, e.userId, courseId);
      if (card?.messageChannel && card.messageTs) open.push({ channel: card.messageChannel, ts: card.messageTs });
    }
    return { completed, open };
  });
  for (const o of open) {
    try {
      await deps.slack.replaceMessage(o.channel, o.ts, textOnly(TEXT.expired));
    } catch (err) {
      console.error('replacing the open card message failed', errText(err));
    }
  }
  for (const c of completed) {
    try {
      await dm(deps, c.userId, TEXT.ended(c.progress));
    } catch (err) {
      console.error(`course-ended message for user ${c.userId} failed`, errText(err));
    }
  }
  return { completed: completed.map((c) => c.userId) };
}

/** Finishes every active course whose `ends_at` has passed (scheduler.md: "At `ends_at` the tick completes every remaining active enrollment"). */
export async function finishEndedCourses(deps: SchedulerDeps, only?: string[]): Promise<string[]> {
  const ids = (await listEndedCourseIds(deps.db, deps.clock.now())).filter((id) => !only || only.includes(id));
  for (const id of ids) {
    try {
      await finishCourse(deps, id);
    } catch (err) {
      console.error(`finishing course ${id} failed`, errText(err));
    }
  }
  return ids;
}
