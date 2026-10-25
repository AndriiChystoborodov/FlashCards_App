import 'dotenv/config';
import { createDb } from './client.js';
import { courses, enrollments, flashcards, users } from './schema.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. Start the test database (npm run db:up) and set it as in .env.example.');

export const { db, pool } = createDb(url);

// Tests use fresh random ids and never truncate, so test files can share the database.
export async function seedCourse(): Promise<{ teacherId: string; studentId: string; courseId: string; cardId: string }> {
  const tag = crypto.randomUUID();
  const [teacher] = await db.insert(users).values({ fullName: 'T', email: `t-${tag}@x.test`, role: 'teacher' }).returning();
  const [student] = await db.insert(users).values({ fullName: 'S', email: `s-${tag}@x.test`, role: 'student' }).returning();
  const [course] = await db
    .insert(courses)
    .values({ teacherId: teacher!.id, title: 'C', materialUrl: 'https://x.test', status: 'draft', endsAt: new Date('2026-02-01T00:00:00Z') })
    .returning();
  const [card] = await db
    .insert(flashcards)
    .values({ courseId: course!.id, question: 'Q', options: ['a', 'b'], correctOption: 0, isAssessment: false, position: 1 })
    .returning();
  return { teacherId: teacher!.id, studentId: student!.id, courseId: course!.id, cardId: card!.id };
}

export const enroll = (courseId: string, userId: string, removedAt: Date | null = null) =>
  db.insert(enrollments).values({ courseId, userId, status: 'active', enrolledAt: new Date('2026-01-01T00:00:00Z'), removedAt });
