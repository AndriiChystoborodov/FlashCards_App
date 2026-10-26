import { applyAnswer, type Answer, type CardState, type Review } from '../domain/calculator.js';
import { evaluateAssessment } from '../domain/assessment.js';
import { dueNotAfter, endOfLocalDay } from '../domain/localDay.js';
import type { Clock } from '../clock.js';
import { getCardState, markLearned, upsertCardState } from '../db/cardStates.js';
import type { Db, Tx } from '../db/client.js';
import { getCourse } from '../db/courses.js';
import { completeAssessment, getEnrollment } from '../db/enrollments.js';
import { getFlashcard, listFlashcardsByCourse } from '../db/flashcards.js';
import { insertReview, listAssessmentReviews } from '../db/reviews.js';
import { getUser } from '../db/users.js';
import { studentTimezone } from './timezone.js';

export interface AnswerDeps {
  db: Db;
  clock: Clock;
  tenantTimezone: string;
}

export interface AnswerInput {
  userId: string;
  flashcardId: string;
  chosenOption: number | null;
  rating?: Answer['rating'];
  /** Slack message the click came from; checked against `card_states.message_ts` when both exist. */
  messageTs?: string;
}

/**
 * Why a click was refused; nothing is stored for any of them. Task 8 maps them to the texts in docs/slack/integration.md and scheduler.md:
 * sent_again, removed, course_over have a text there; not_open and not_enrolled have none yet.
 */
export type RejectReason = 'not_open' | 'not_enrolled' | 'removed' | 'course_over' | 'sent_again';

export type AssessmentOutcome = { score: number | null; exempt: boolean; learnedFlashcardIds: string[] };

export type AnswerResult =
  | {
      status: 'answered';
      review: Review;
      state: CardState;
      correctOption: number;
      materialUrl: string;
      /** The clamped `due` (and what FSRS wanted) when the clamp applied. */
      clampedFrom: Date | null;
      /** Set only when this answer was the last assessment card. */
      assessment: AssessmentOutcome | null;
    }
  | { status: 'rejected'; reason: RejectReason }
  | { status: 'duplicate' };

export class InvalidOptionError extends Error {
  constructor(option: number, optionCount: number) {
    super(`chosen option ${option} is not one of the ${optionCount} options`);
    this.name = 'InvalidOptionError';
  }
}

const reject = (reason: RejectReason): AnswerResult => ({ status: 'rejected', reason });

/** The checks every click shares, in the order of decision 0025 #4. Writes nothing. */
async function guardClick(tx: Db | Tx, input: Pick<AnswerInput, 'userId' | 'flashcardId' | 'messageTs'>) {
  const card = await getFlashcard(tx, input.flashcardId);
  if (!card) return { ok: false as const, reason: 'not_open' as const };
  const course = await getCourse(tx, card.courseId);
  const enrollment = await getEnrollment(tx, card.courseId, input.userId);
  if (!course || !enrollment) return { ok: false as const, reason: 'not_enrolled' as const };
  // Removed is checked before "not open": removal voids the open card, so it would match too (S41).
  if (enrollment.removedAt) return { ok: false as const, reason: 'removed' as const };
  if (enrollment.status !== 'active' || course.status !== 'active') return { ok: false as const, reason: 'course_over' as const };
  const record = await getCardState(tx, input.userId, input.flashcardId);
  if (!record?.sentAt) return { ok: false as const, reason: 'not_open' as const };
  if (input.messageTs && record.messageTs && input.messageTs !== record.messageTs) return { ok: false as const, reason: 'sent_again' as const };
  return { ok: true as const, card, course, enrollment, record, sentAt: record.sentAt };
}

export type PreviewResult = { status: 'checked'; isCorrect: boolean } | { status: 'rejected'; reason: RejectReason };

/**
 * The first click of Slack's two-step answer: the same checks as `submitAnswer`, and whether the option is right, with no write at all
 * (decision 0025 #2). A right answer then waits for the rating click; a wrong one goes straight to `submitAnswer`.
 */
export async function previewAnswer(deps: Pick<AnswerDeps, 'db'>, input: Omit<AnswerInput, 'rating'>): Promise<PreviewResult> {
  const guarded = await guardClick(deps.db, input);
  if (!guarded.ok) return { status: 'rejected', reason: guarded.reason };
  const { card } = guarded;
  const o = input.chosenOption;
  if (o !== null && (!Number.isInteger(o) || o < 0 || o >= card.options.length)) throw new InvalidOptionError(o, card.options.length);
  return { status: 'checked', isCorrect: o === card.correctOption };
}

/** One transaction: review insert, FSRS state, `due` clamp, and the assessment evaluation on the last assessment card. */
export async function submitAnswer(deps: AnswerDeps, input: AnswerInput): Promise<AnswerResult> {
  const now = deps.clock.now();
  const { userId, flashcardId, chosenOption } = input;

  return deps.db.transaction(async (tx) => {
    const guarded = await guardClick(tx, input);
    if (!guarded.ok) return reject(guarded.reason);
    const { card, course, enrollment, record, sentAt } = guarded;
    if (chosenOption !== null && (!Number.isInteger(chosenOption) || chosenOption < 0 || chosenOption >= card.options.length)) {
      throw new InvalidOptionError(chosenOption, card.options.length);
    }

    const answer: Answer = input.rating ? { chosenOption, rating: input.rating } : { chosenOption };
    const applied = applyAnswer(card, record.state, answer, now);

    // The insert comes first: the unique delivery key is the lock, so a second click writes nothing.
    const inserted = await insertReview(tx, { ...applied.review, userId, flashcardId, deliverySentAt: sentAt });
    if (!inserted) return { status: 'duplicate' };

    const user = await getUser(tx, userId);
    const tz = studentTimezone(user, deps.tenantTimezone, userId);
    const limit = dueNotAfter(tz, course.endsAt);
    const state = applied.state;
    let clampedFrom: Date | null = null;
    // Clamp only to a later local day: clamping to today would make next() select the card again at once (decision 0025, amendment).
    if (state.due > limit && limit > endOfLocalDay(tz, now)) {
      clampedFrom = state.due;
      state.due = limit;
    }
    await upsertCardState(tx, { ...record, state, sentAt: null, remindedAt: null, reminderCount: 0 });

    let assessment: AssessmentOutcome | null = null;
    if (card.isAssessment && !enrollment.assessmentDoneAt) {
      const total = (await listFlashcardsByCourse(tx, card.courseId)).filter((f) => f.isAssessment).length;
      const answered = await listAssessmentReviews(tx, userId, card.courseId);
      if (answered.length === total) {
        const { passedFlags, score, exempt } = evaluateAssessment(answered, course.assessmentPassThreshold);
        const learnedFlashcardIds = exempt ? [] : answered.filter((_, i) => passedFlags[i]).map((r) => r.flashcardId);
        await markLearned(tx, userId, learnedFlashcardIds, now);
        await completeAssessment(tx, card.courseId, userId, { doneAt: now, score, status: exempt ? 'exempt' : 'active' });
        if (learnedFlashcardIds.includes(flashcardId)) state.learnedAt = now;
        assessment = { score, exempt, learnedFlashcardIds };
      }
    }

    return {
      status: 'answered',
      review: applied.review,
      state,
      correctOption: card.correctOption,
      materialUrl: card.materialUrl ?? course.materialUrl,
      clampedFrom,
      assessment,
    };
  });
}
