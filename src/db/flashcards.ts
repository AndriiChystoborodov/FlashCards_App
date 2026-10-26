import { asc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { flashcards } from './schema.js';

export const listFlashcardsByCourse = (db: DbOrTx, courseId: string) =>
  db.select().from(flashcards).where(eq(flashcards.courseId, courseId)).orderBy(asc(flashcards.position));

export async function getFlashcard(db: DbOrTx, id: string) {
  const [row] = await db.select().from(flashcards).where(eq(flashcards.id, id));
  return row ?? null;
}

export type FlashcardRow = typeof flashcards.$inferSelect;

export async function maxPosition(db: DbOrTx, courseId: string): Promise<number> {
  const [r] = await db.select({ m: sql<number>`coalesce(max(${flashcards.position}), 0)::int` }).from(flashcards).where(eq(flashcards.courseId, courseId));
  return r?.m ?? 0;
}

export const insertFlashcards = (db: DbOrTx, rows: (typeof flashcards.$inferInsert)[]) => db.insert(flashcards).values(rows).returning();

export async function updateFlashcard(db: DbOrTx, id: string, set: { isAssessment?: boolean; materialUrl?: string | null }): Promise<void> {
  if (Object.keys(set).length > 0) await db.update(flashcards).set(set).where(eq(flashcards.id, id));
}

export const deleteFlashcard = async (db: DbOrTx, id: string): Promise<void> => {
  await db.delete(flashcards).where(eq(flashcards.id, id));
};

/** Moves one card to `position` (1-based, clamped) and renumbers the course 1..n, so positions stay unique. */
export async function moveFlashcard(db: DbOrTx, courseId: string, id: string, position: number): Promise<void> {
  const ids = (await listFlashcardsByCourse(db, courseId)).map((c) => c.id).filter((x) => x !== id);
  ids.splice(Math.min(Math.max(position, 1), ids.length + 1) - 1, 0, id);
  for (const [i, cardId] of ids.entries()) await db.update(flashcards).set({ position: i + 1 }).where(eq(flashcards.id, cardId));
}
