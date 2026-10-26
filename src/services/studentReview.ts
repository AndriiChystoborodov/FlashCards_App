import { getFlashcard } from '../db/flashcards.js';
import { getEnrollment } from '../db/enrollments.js';
import { getUser } from '../db/users.js';
import { coursesOfStudent } from '../db/progress.js';
import { countCards } from '../db/selection.js';
import { learnedByUser } from '../db/progress.js';
import type { Answer } from '../domain/calculator.js';
import { MissingRatingError } from '../domain/calculator.js';
import { InvalidOptionError, submitAnswer } from './answer.js';
import { ServiceError } from './errors.js';
import { progressValue } from './progress.js';
import { afterAnswer, type SchedulerDeps } from './scheduler.js';

/** The student route's answer (decision 0018: dev and tests only). Same path as a Slack click: submitAnswer, then afterAnswer. */
export async function answerCard(deps: SchedulerDeps, userId: string, flashcardId: string, chosenOption: number | null, rating?: Answer['rating']) {
  let result;
  try {
    result = await submitAnswer(deps, { userId, flashcardId, chosenOption, ...(rating && { rating }) });
  } catch (err) {
    if (err instanceof MissingRatingError) throw new ServiceError('rating_required', 'A right answer needs a rating: hard, medium or easy.');
    if (err instanceof InvalidOptionError) throw new ServiceError('invalid_option', 'The chosen option is not one of the options of this card.');
    throw err;
  }
  if (result.status === 'duplicate') throw new ServiceError('duplicate', 'This card was already answered.');
  if (result.status === 'rejected') throw new ServiceError(result.reason, `The answer was refused: ${result.reason}.`);
  const card = (await getFlashcard(deps.db, flashcardId))!;
  await afterAnswer(deps, userId, card.courseId, result);
  return {
    isCorrect: result.review.isCorrect,
    correctOption: result.correctOption,
    rating: result.review.rating,
    materialUrl: result.materialUrl,
    progress: await progressIn(deps, userId, card.courseId),
  };
}

async function progressIn(deps: SchedulerDeps, userId: string, courseId: string): Promise<number> {
  const e = await getEnrollment(deps.db, courseId, userId);
  if (!e) return 0;
  return progressValue(e, (await learnedByUser(deps.db, courseId)).get(userId) ?? 0, await countCards(deps.db, courseId));
}

export async function coursesFor(deps: SchedulerDeps, userId: string) {
  if (!(await getUser(deps.db, userId))) throw new ServiceError('not_found', 'User not found.');
  const rows = await coursesOfStudent(deps.db, userId);
  return Promise.all(rows.map(async ({ course, enrollment }) => ({ course, enrollment, progress: await progressIn(deps, userId, course.id) })));
}
