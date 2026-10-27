import { checkQuestion } from '../render/card.js';
import { lockCourse } from '../db/courses.js';
import { deleteFlashcard as deleteCard, getFlashcard, insertFlashcards, listFlashcardsByCourse, maxPosition, moveFlashcard, updateFlashcard, type FlashcardRow } from '../db/flashcards.js';
import { ownedCourse } from './courses.js';
import { ServiceError } from './errors.js';
import type { SchedulerDeps } from './scheduler.js';

export interface NewFlashcard {
  question: string;
  options: string[];
  correctOption: number;
  materialUrl?: string | null;
  isAssessment: boolean;
}

const QUESTION_MESSAGE = {
  question_too_long: 'the question is longer than 500 characters or does not fit on the card.',
  unsupported_character: 'the question has a character that cannot be drawn (emoji, right-to-left and Asian scripts are not supported; Latin, Cyrillic and Greek are).',
  empty_question: 'the question is empty after removing invisible characters.',
} as const;

/** decision 0016: add on draft or active; an active course takes no assessment cards; finished takes nothing. All or nothing. */
export async function addFlashcards(deps: SchedulerDeps, teacherId: string, courseId: string, cards: NewFlashcard[]): Promise<FlashcardRow[]> {
  await ownedCourse(deps, teacherId, courseId);
  // Decision 0034: a question is drawn on an image, so it is cleaned (invisible characters, spaces) and limited before anything is stored;
  // the cleaned text is what is stored. The message names the card by number and never echoes the input.
  const questions: string[] = [];
  for (const [i, c] of cards.entries()) {
    const v = checkQuestion(c.question);
    if (!v.ok) throw new ServiceError(v.code, `Card ${i + 1}: ${QUESTION_MESSAGE[v.code]}`);
    questions.push(v.text);
    await new Promise((r) => setImmediate(r)); // a hostile card costs up to ~30 ms of measuring: let other requests run between cards
  }
  return deps.db.transaction(async (tx) => {
    const course = await lockCourse(tx, courseId);
    if (!course) throw new ServiceError('not_found', 'Course not found.');
    if (course.status === 'finished') throw new ServiceError('course_finished', 'Cards cannot be added to a finished course.');
    if (course.status === 'active' && cards.some((c) => c.isAssessment)) {
      throw new ServiceError('assessment_closed', 'The assessment has already run; cards added to a running course cannot be assessment cards.');
    }
    const start = await maxPosition(tx, courseId);
    return insertFlashcards(tx, cards.map((c, i) => ({ courseId, question: questions[i]!, options: c.options, correctOption: c.correctOption, isAssessment: c.isAssessment, materialUrl: c.materialUrl ?? null, position: start + i + 1 })));
  });
}

export async function listFlashcards(deps: Pick<SchedulerDeps, 'db'>, teacherId: string, courseId: string): Promise<FlashcardRow[]> {
  await ownedCourse(deps, teacherId, courseId);
  return listFlashcardsByCourse(deps.db, courseId);
}

/** Edit or delete: draft courses only (decision 0016), also for `finished`. Another teacher's card is `not_found`. */
async function editable<T>(deps: SchedulerDeps, teacherId: string, flashcardId: string, fn: (tx: Parameters<Parameters<SchedulerDeps['db']['transaction']>[0]>[0], card: FlashcardRow) => Promise<T>): Promise<T> {
  const card = await getFlashcard(deps.db, flashcardId);
  if (!card) throw new ServiceError('not_found', 'Flashcard not found.');
  return deps.db.transaction(async (tx) => {
    const course = await lockCourse(tx, card.courseId);
    if (!course || course.teacherId !== teacherId) throw new ServiceError('not_found', 'Flashcard not found.');
    if (course.status !== 'draft') throw new ServiceError('course_not_draft', 'Flashcards can be changed only while the course is a draft.');
    const fresh = await getFlashcard(tx, flashcardId);
    if (!fresh) throw new ServiceError('not_found', 'Flashcard not found.');
    return fn(tx, fresh);
  });
}

export async function patchFlashcard(deps: SchedulerDeps, teacherId: string, flashcardId: string, p: { isAssessment?: boolean; position?: number; materialUrl?: string | null }): Promise<FlashcardRow> {
  return editable(deps, teacherId, flashcardId, async (tx, card) => {
    await updateFlashcard(tx, flashcardId, { ...(p.isAssessment !== undefined && { isAssessment: p.isAssessment }), ...(p.materialUrl !== undefined && { materialUrl: p.materialUrl }) });
    if (p.position !== undefined) await moveFlashcard(tx, card.courseId, flashcardId, p.position);
    return (await getFlashcard(tx, flashcardId))!;
  });
}

export async function deleteFlashcard(deps: SchedulerDeps, teacherId: string, flashcardId: string): Promise<void> {
  await editable(deps, teacherId, flashcardId, (tx) => deleteCard(tx, flashcardId));
}
