import { and, asc, count, eq, gte, isNotNull, isNull, lte, or } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { cardStates, flashcards } from './schema.js';

// Queries behind scheduler.md "Selecting the next card". Each returns one card or a count; the rules live in the scheduler service.

export type Flashcard = typeof flashcards.$inferSelect;

const rowOf = (userId: string) => and(eq(cardStates.userId, userId), eq(cardStates.flashcardId, flashcards.id));

/** The card the student has open (`sent_at` set) in this course, with its Slack message. */
export async function getOpenCard(db: DbOrTx, userId: string, courseId: string) {
  const [row] = await db
    .select({ flashcardId: cardStates.flashcardId, sentAt: cardStates.sentAt, messageChannel: cardStates.messageChannel, messageTs: cardStates.messageTs })
    .from(cardStates)
    .innerJoin(flashcards, eq(flashcards.id, cardStates.flashcardId))
    .where(and(eq(cardStates.userId, userId), eq(flashcards.courseId, courseId), isNotNull(cardStates.sentAt)));
  return row ?? null;
}

export async function countAssessmentCards(db: DbOrTx, courseId: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(flashcards).where(and(eq(flashcards.courseId, courseId), eq(flashcards.isAssessment, true)));
  return r?.n ?? 0;
}

/**
 * Assessment card or not, the first card by position that has no `card_states` row for the student. For assessment cards a voided
 * one also counts (row exists, not open, never answered: removal cleared `sent_at`, S42), or the restored student would be stuck.
 */
export async function nextUnsentCard(db: DbOrTx, userId: string, courseId: string, assessment: boolean): Promise<Flashcard | null> {
  const [row] = await db
    .select({ card: flashcards })
    .from(flashcards)
    .leftJoin(cardStates, rowOf(userId))
    .where(and(eq(flashcards.courseId, courseId), eq(flashcards.isAssessment, assessment),
        assessment ? or(isNull(cardStates.userId), and(isNull(cardStates.sentAt), isNull(cardStates.lastReview))) : isNull(cardStates.userId)))
    .orderBy(asc(flashcards.position))
    .limit(1);
  return row?.card ?? null;
}

/** Not learned, not open, due by `endOfDay`: earliest `due` first, ties by position. */
export async function nextDueCard(db: DbOrTx, userId: string, courseId: string, endOfDay: Date): Promise<Flashcard | null> {
  const [row] = await db
    .select({ card: flashcards })
    .from(cardStates)
    .innerJoin(flashcards, eq(flashcards.id, cardStates.flashcardId))
    .where(and(eq(cardStates.userId, userId), eq(flashcards.courseId, courseId), isNull(cardStates.learnedAt), isNull(cardStates.sentAt), lte(cardStates.due, endOfDay)))
    .orderBy(asc(cardStates.due), asc(flashcards.position))
    .limit(1);
  return row?.card ?? null;
}

export async function countUnsentNormalCards(db: DbOrTx, userId: string, courseId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(flashcards)
    .leftJoin(cardStates, rowOf(userId))
    .where(and(eq(flashcards.courseId, courseId), eq(flashcards.isAssessment, false), isNull(cardStates.userId)));
  return r?.n ?? 0;
}

/** Non-assessment cards first sent inside [from, to] (the student's local day); assessment cards never count (decision 0006). */
export async function countIntroducedBetween(db: DbOrTx, userId: string, courseId: string, from: Date, to: Date): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(cardStates)
    .innerJoin(flashcards, eq(flashcards.id, cardStates.flashcardId))
    .where(and(eq(cardStates.userId, userId), eq(flashcards.courseId, courseId), eq(flashcards.isAssessment, false), gte(cardStates.introducedAt, from), lte(cardStates.introducedAt, to)));
  return r?.n ?? 0;
}

export async function countLearned(db: DbOrTx, userId: string, courseId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(cardStates)
    .innerJoin(flashcards, eq(flashcards.id, cardStates.flashcardId))
    .where(and(eq(cardStates.userId, userId), eq(flashcards.courseId, courseId), isNotNull(cardStates.learnedAt)));
  return r?.n ?? 0;
}

export async function countCards(db: DbOrTx, courseId: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(flashcards).where(eq(flashcards.courseId, courseId));
  return r?.n ?? 0;
}
