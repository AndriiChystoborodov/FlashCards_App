import { deleteCourseCascade, insertCourse, listCoursesWithCounts, lockCourse, updateCourse, type Course, type CourseWithCounts } from '../db/courses.js';
import { listPresentEnrollments } from '../db/enrollments.js';
import { countCards } from '../db/selection.js';
import { dm, finishCourse, sendFirstCards, TEXT, type SchedulerDeps } from './scheduler.js';
import { ServiceError } from './errors.js';
import { errText } from './logError.js';

export interface NewCourse {
  title: string;
  materialUrl: string;
  endsAt: Date;
  scheduledStartAt?: Date | null;
  assessmentPassThreshold?: number;
}
export type CoursePatch = Partial<Omit<NewCourse, 'scheduledStartAt'>> & { scheduledStartAt?: Date | null };

const notFound = () => new ServiceError('not_found', 'Course not found.');

/** The course if it belongs to this teacher; another teacher's course is `not_found`, never 403 (rest-api.md). */
export async function ownedCourse(deps: Pick<SchedulerDeps, 'db'>, teacherId: string, courseId: string): Promise<CourseWithCounts> {
  const [c] = await listCoursesWithCounts(deps.db, teacherId, courseId);
  if (!c) throw notFound();
  return c;
}

export async function createCourse(deps: SchedulerDeps, teacherId: string, v: NewCourse): Promise<CourseWithCounts> {
  const c = await insertCourse(deps.db, {
    teacherId, title: v.title, materialUrl: v.materialUrl, status: 'draft', endsAt: v.endsAt,
    scheduledStartAt: v.scheduledStartAt ?? null, ...(v.assessmentPassThreshold !== undefined && { assessmentPassThreshold: v.assessmentPassThreshold }),
  });
  return ownedCourse(deps, teacherId, c.id);
}

export const listCourses = (deps: Pick<SchedulerDeps, 'db'>, teacherId: string) => listCoursesWithCounts(deps.db, teacherId);

/** Runs `fn` with the course row locked, after the ownership check. */
async function locked<T>(deps: SchedulerDeps, teacherId: string, courseId: string, fn: (tx: Parameters<Parameters<SchedulerDeps['db']['transaction']>[0]>[0], course: Course) => Promise<T>): Promise<T> {
  return deps.db.transaction(async (tx) => {
    const course = await lockCourse(tx, courseId);
    if (!course || course.teacherId !== teacherId) throw notFound();
    return fn(tx, course);
  });
}

/** rest-api.md PATCH rules. Check order: finished, threshold_locked, ends_at_shortened. */
export async function patchCourse(deps: SchedulerDeps, teacherId: string, courseId: string, p: CoursePatch): Promise<CourseWithCounts> {
  await locked(deps, teacherId, courseId, async (tx, course) => {
    if (course.status === 'finished') throw new ServiceError('course_finished', 'A finished course is read-only.');
    if (course.status === 'active') {
      if (p.assessmentPassThreshold !== undefined) throw new ServiceError('threshold_locked', 'The pass threshold cannot change after the course has started.');
      if (p.endsAt && p.endsAt < course.endsAt) throw new ServiceError('ends_at_shortened', 'The end date of a running course can only move later.');
    }
    await updateCourse(tx, courseId, {
      ...(p.title !== undefined && { title: p.title }),
      ...(p.materialUrl !== undefined && { materialUrl: p.materialUrl }),
      ...(p.endsAt !== undefined && { endsAt: p.endsAt }),
      ...(p.scheduledStartAt !== undefined && { scheduledStartAt: p.scheduledStartAt }),
      ...(p.assessmentPassThreshold !== undefined && { assessmentPassThreshold: p.assessmentPassThreshold }),
    });
  });
  return ownedCourse(deps, teacherId, courseId);
}

/** draft to active; a DM to every present active student, then the first assessment card at once (integration.md). */
export async function startCourse(deps: SchedulerDeps, teacherId: string, courseId: string): Promise<CourseWithCounts> {
  const now = deps.clock.now();
  let title = '';
  await locked(deps, teacherId, courseId, async (tx, course) => {
    title = course.title;
    if (course.status !== 'draft') throw new ServiceError('course_not_draft', 'Only a draft course can be started.');
    if (course.endsAt <= now) throw new ServiceError('ends_at_passed', 'The end date is in the past; move it with PATCH first.');
    if ((await countCards(tx, courseId)) === 0) throw new ServiceError('no_cards', 'Add at least one flashcard before starting.');
    await updateCourse(tx, courseId, { status: 'active', startsAt: now });
  });
  for (const e of await listPresentEnrollments(deps.db, courseId)) {
    if (e.status !== 'active') continue;
    try {
      await dm(deps, e.userId, TEXT.started(title));
    } catch (err) {
      console.error(`start message for user ${e.userId} failed`, errText(err));
    }
  }
  await sendFirstCards(deps, courseId);
  return ownedCourse(deps, teacherId, courseId);
}

/** active to finished through the scheduler's `finishCourse` (decision 0011). */
export async function stopCourse(deps: SchedulerDeps, teacherId: string, courseId: string): Promise<CourseWithCounts> {
  const course = await ownedCourse(deps, teacherId, courseId);
  if (course.status !== 'active') throw new ServiceError('course_not_active', 'Only a running course can be stopped.');
  await finishCourse(deps, courseId);
  return ownedCourse(deps, teacherId, courseId);
}

export async function deleteCourse(deps: SchedulerDeps, teacherId: string, courseId: string): Promise<void> {
  await locked(deps, teacherId, courseId, async (tx, course) => {
    if (course.status !== 'draft') throw new ServiceError('course_not_draft', 'Only a draft course can be deleted; stop a running course instead.');
    await deleteCourseCascade(tx, courseId);
  });
}
