import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { newCardState } from '../domain/calculator.js';
import { upsertCardState } from './cardStates.js';
import { listPresentEnrollments } from './enrollments.js';
import { listFlashcardsByCourse } from './flashcards.js';
import { insertReview } from './reviews.js';
import { cardStates, courses, enrollments, flashcards, reviews, users } from './schema.js';
import { db, enroll, pool, seedCourse } from './testDb.js';

afterAll(() => pool.end());

const at = new Date('2026-01-05T10:00:00Z');

describe('schema (needs the migrated test database)', () => {
  it('D12: migration created all tables with row level security on', async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname = any($1) and relkind = 'r'`,
      [['users', 'courses', 'enrollments', 'flashcards', 'card_states', 'reviews']],
    );
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('D7: composite primary keys reject duplicates', async () => {
    const { studentId, courseId, cardId } = await seedCourse();
    await enroll(courseId, studentId);
    await expect(enroll(courseId, studentId)).rejects.toThrow();
    await upsertCardState(db, {
      userId: studentId, flashcardId: cardId, state: newCardState(at), introducedAt: at,
      sentAt: null, remindedAt: null, reminderCount: 0, messageChannel: null, messageTs: null,
    });
    const [row] = await db.select().from(cardStates).where(eq(cardStates.userId, studentId));
    await expect(db.insert(cardStates).values(row!)).rejects.toThrow();
  });

  it('D8: second review for the same delivery is ignored', async () => {
    const { studentId, cardId } = await seedCourse();
    const r = { userId: studentId, flashcardId: cardId, chosenOption: null, isCorrect: false, rating: null, reviewedAt: at, deliverySentAt: at };
    expect(await insertReview(db, r)).toBe(true);
    expect(await insertReview(db, { ...r, reviewedAt: new Date('2026-01-05T10:00:05Z') })).toBe(false);
    expect(await insertReview(db, { ...r, deliverySentAt: new Date('2026-01-06T10:00:00Z') })).toBe(true);
  });

  it('D9: present predicate hides removed enrollments', async () => {
    const { studentId, courseId } = await seedCourse();
    const [other] = await db.insert(users).values({ fullName: 'O', email: `o-${crypto.randomUUID()}@x.test`, role: 'student' }).returning();
    await enroll(courseId, studentId);
    await enroll(courseId, other!.id, at);
    const present = await listPresentEnrollments(db, courseId);
    expect(present.map((e) => e.userId)).toEqual([studentId]);
  });

  it('D10: defaults (threshold 90, streak 0, reminder count 0)', async () => {
    const { courseId, studentId, cardId } = await seedCourse();
    const [c] = await db.select().from(courses).where(eq(courses.id, courseId));
    expect(c?.assessmentPassThreshold).toBe(90);
    await db.insert(cardStates).values({
      userId: studentId, flashcardId: cardId, due: at, stability: 0, difficulty: 0, elapsedDays: 0,
      scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: 0, introducedAt: at,
    });
    const [s] = await db.select().from(cardStates).where(eq(cardStates.userId, studentId));
    expect([s?.correctStreak, s?.reminderCount]).toEqual([0, 0]);
  });

  it('D11: courses.ends_at is NOT NULL', async () => {
    const { teacherId } = await seedCourse();
    await expect(
      pool.query(`insert into courses (teacher_id, title, material_url, status) values ($1, 't', 'u', 'draft')`, [teacherId]),
    ).rejects.toThrow(/ends_at/);
  });

  it('CHECK constraints reject unknown text values', async () => {
    const { teacherId } = await seedCourse();
    await expect(db.insert(users).values({ fullName: 'x', email: `x-${crypto.randomUUID()}@x.test`, role: 'admin' })).rejects.toThrow();
    await expect(
      db.insert(courses).values({ teacherId, title: 't', materialUrl: 'u', status: 'open', endsAt: at }),
    ).rejects.toThrow();
    const { studentId, courseId } = await seedCourse();
    await expect(db.insert(enrollments).values({ courseId, userId: studentId, status: 'gone', enrolledAt: at })).rejects.toThrow();
  });

  it('CHECK constraints reject state 4 and an unknown rating', async () => {
    const { studentId, cardId } = await seedCourse();
    await expect(
      db.insert(cardStates).values({
        userId: studentId, flashcardId: cardId, due: at, stability: 0, difficulty: 0, elapsedDays: 0,
        scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: 4, introducedAt: at,
      }),
    ).rejects.toThrow();
    const r = { userId: studentId, flashcardId: cardId, chosenOption: 0, isCorrect: true, rating: 'great', reviewedAt: at, deliverySentAt: at };
    await expect(db.insert(reviews).values(r)).rejects.toThrow();
  });

  it('lists flashcards of a course by position', async () => {
    const { courseId } = await seedCourse();
    await db.insert(flashcards).values({ courseId, question: 'Q0', options: ['a', 'b'], correctOption: 1, isAssessment: true, position: 0 });
    const list = await listFlashcardsByCourse(db, courseId);
    expect(list.map((f) => f.position)).toEqual([0, 1]);
    expect(list[0]?.options).toEqual(['a', 'b']);
  });
});
