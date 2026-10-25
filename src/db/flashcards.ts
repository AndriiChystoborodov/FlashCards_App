import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { flashcards } from './schema.js';

export const listFlashcardsByCourse = (db: DbOrTx, courseId: string) =>
  db.select().from(flashcards).where(eq(flashcards.courseId, courseId)).orderBy(asc(flashcards.position));
