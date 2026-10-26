import { lockCourse } from '../db/courses.js';
import { hardDeleteEnrollment, getEnrollment, insertEnrollment, listStudents as listEnrolled, lockEnrollment, restoreEnrollment, softRemoveEnrollment } from '../db/enrollments.js';
import { voidOpenCard } from '../db/cardStates.js';
import { getOpenCard } from '../db/selection.js';
import { findUserByEmail, insertStudent, setSlackIdentity } from '../db/users.js';
import { textOnly } from '../slack/card.js';
import { ownedCourse } from './courses.js';
import { ServiceError } from './errors.js';
import { errText } from './logError.js';
import { dm, sendNext, TEXT, type SchedulerDeps } from './scheduler.js';

export interface EnrollResult {
  email: string;
  enrolled: boolean;
  slackMatched: boolean;
  restored: boolean;
}

const DAY_MS = 86_400_000;

/**
 * rest-api.md "Class". Creates missing users, looks up Slack, enrolls. An email removed less than `retentionDays` ago is
 * restored (decision 0017); one removed longer ago is cleaned up first (what the daily job would have done) and enrolled fresh.
 * On an active course the first card goes out at once.
 */
export async function enrollStudents(deps: SchedulerDeps, retentionDays: number, teacherId: string, courseId: string, students: { email: string; name: string }[]): Promise<EnrollResult[]> {
  const course = await ownedCourse(deps, teacherId, courseId);
  if (course.status === 'finished') throw new ServiceError('course_finished', 'Students cannot be enrolled in a finished course.');
  const results: EnrollResult[] = [];
  for (const s of students) {
    const now = deps.clock.now();
    await insertStudent(deps.db, { email: s.email, fullName: s.name });
    let user = (await findUserByEmail(deps.db, s.email))!;
    if (user.role !== 'student') {
      // a teacher's email is never enrolled, and nothing about it is revealed (no Slack lookup, no match flag)
      results.push({ email: s.email, enrolled: false, slackMatched: false, restored: false });
      continue;
    }
    if (!user.slackId) {
      try {
        const found = await deps.slack.lookupEmail(s.email);
        if (found) {
          await setSlackIdentity(deps.db, user.id, found.slackId, user.tz ? null : found.tz);
          user = (await findUserByEmail(deps.db, s.email))!;
        }
      } catch (err) {
        console.error(`Slack lookup for user ${user.id} failed`, errText(err));
      }
    }
    let enrolled = false;
    let status = course.status;
    let restored = false;
    const existing = await getEnrollment(deps.db, courseId, user.id);
    if (existing?.removedAt && now.getTime() - existing.removedAt.getTime() >= retentionDays * DAY_MS) {
      await deps.db.transaction((tx) => hardDeleteEnrollment(tx, courseId, user.id));
    }
    const current = existing?.removedAt && now.getTime() - existing.removedAt.getTime() < retentionDays * DAY_MS ? existing : null;
    if (current) {
      enrolled = restored = await restoreEnrollment(deps.db, courseId, user.id);
    } else if (!existing || existing.removedAt) {
      enrolled = await deps.db.transaction(async (tx) => {
        const c = await lockCourse(tx, courseId); // the course may have been stopped or deleted since the check above
        if (!c) throw new ServiceError('not_found', 'Course not found.');
        if (c.status === 'finished') throw new ServiceError('course_finished', 'Students cannot be enrolled in a finished course.');
        status = c.status;
        return insertEnrollment(tx, courseId, user.id, now);
      });
    }
    if (enrolled && status === 'active') {
      try {
        if (restored) await dm(deps, user.id, TEXT.restored);
        await sendNext(deps, user.id, courseId);
      } catch (err) {
        console.error(`first card for user ${user.id} failed`, errText(err));
      }
    }
    results.push({ email: s.email, enrolled, slackMatched: user.slackId !== null, restored });
  }
  return results;
}

export async function listStudents(deps: Pick<SchedulerDeps, 'db'>, teacherId: string, courseId: string) {
  await ownedCourse(deps, teacherId, courseId);
  return listEnrolled(deps.db, courseId);
}

/** decision 0017: soft delete; the open card is voided and its message replaced. Repeating the call changes nothing. */
export async function removeStudent(deps: SchedulerDeps, teacherId: string, courseId: string, studentId: string): Promise<void> {
  await ownedCourse(deps, teacherId, courseId);
  const now = deps.clock.now();
  const open = await deps.db.transaction(async (tx) => {
    const e = await lockEnrollment(tx, courseId, studentId);
    if (!e) throw new ServiceError('not_found', 'Student not found in this course.');
    if (!(await softRemoveEnrollment(tx, courseId, studentId, now))) return null;
    const card = await getOpenCard(tx, studentId, courseId);
    if (!card) return null;
    await voidOpenCard(tx, studentId, card.flashcardId);
    return card.messageChannel && card.messageTs ? { channel: card.messageChannel, ts: card.messageTs } : null;
  });
  if (open) {
    try {
      await deps.slack.replaceMessage(open.channel, open.ts, textOnly(TEXT.removed));
    } catch (err) {
      console.error('replacing the open card message failed', errText(err));
    }
  }
}
