import express, { Router, type RequestHandler } from 'express';
import { createCourse, deleteCourse, listCourses, ownedCourse, patchCourse, startCourse, stopCourse } from '../services/courses.js';
import { enrollStudents, listStudents, removeStudent } from '../services/enrollment.js';
import { addFlashcards, deleteFlashcard, listFlashcards, patchFlashcard } from '../services/flashcards.js';
import { courseProgress, studentProgress } from '../services/progress.js';
import { teacherForToken } from '../services/auth.js';
import type { SchedulerDeps } from '../services/scheduler.js';
import { HttpError, id, parse } from './errors.js';
import * as present from './present.js';
import * as s from './schemas.js';

/** `Authorization: Bearer <token>` to `res.locals.teacherId` (decision 0014). The header value is never logged or echoed. */
const authenticate = (deps: Pick<SchedulerDeps, 'db'>): RequestHandler => async (req, res, next) => {
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.get('authorization') ?? '');
  const teacherId = m ? await teacherForToken(deps.db, m[1]!) : null;
  if (!teacherId) throw new HttpError(401, 'unauthorized', 'Missing or invalid bearer token.');
  res.locals.teacherId = teacherId;
  next();
};

export function teacherRouter(deps: SchedulerDeps, retentionDays: number): Router {
  const r = Router();
  // Only the teacher paths are authenticated, so an unknown route (or a disabled student route) is 404, not 401.
  r.use(['/courses', '/flashcards'], authenticate(deps), express.json({ limit: '1mb' })); // the body is parsed only for authenticated callers
  const t = (res: { locals: Record<string, unknown> }) => res.locals.teacherId as string;

  r.post('/courses', async (req, res) => {
    const b = parse(s.createCourse, req.body);
    const c = await createCourse(deps, t(res), { title: b.title, materialUrl: b.material_url, endsAt: b.ends_at, scheduledStartAt: b.scheduled_start_at ?? null, assessmentPassThreshold: b.assessment_pass_threshold });
    res.status(201).json(present.course(c));
  });
  r.get('/courses', async (_req, res) => void res.json({ courses: (await listCourses(deps, t(res))).map(present.course) }));
  r.get('/courses/:courseId', async (req, res) => void res.json(present.course(await ownedCourse(deps, t(res), id(req.params.courseId)))));
  r.patch('/courses/:courseId', async (req, res) => {
    const courseId = id(req.params.courseId);
    const b = parse(s.patchCourse, req.body);
    const c = await patchCourse(deps, t(res), courseId, {
      title: b.title, materialUrl: b.material_url, endsAt: b.ends_at, scheduledStartAt: b.scheduled_start_at, assessmentPassThreshold: b.assessment_pass_threshold,
    });
    res.json(present.course(c));
  });
  r.post('/courses/:courseId/start', async (req, res) => void res.json(present.course(await startCourse(deps, t(res), id(req.params.courseId)))));
  r.post('/courses/:courseId/stop', async (req, res) => void res.json(present.course(await stopCourse(deps, t(res), id(req.params.courseId)))));
  r.delete('/courses/:courseId', async (req, res) => {
    await deleteCourse(deps, t(res), id(req.params.courseId));
    res.status(204).end();
  });

  r.post('/courses/:courseId/flashcards', async (req, res) => {
    const courseId = id(req.params.courseId);
    const b = parse(s.addFlashcards, req.body);
    const rows = await addFlashcards(deps, t(res), courseId, b.flashcards.map((c) => ({ question: c.question, options: c.options, correctOption: c.correct_option, materialUrl: c.material_url ?? null, isAssessment: c.is_assessment })));
    res.status(201).json({ flashcards: rows.map((f) => ({ flashcard_id: f.id, position: f.position })) });
  });
  r.get('/courses/:courseId/flashcards', async (req, res) => void res.json({ flashcards: (await listFlashcards(deps, t(res), id(req.params.courseId))).map(present.flashcard) }));
  r.patch('/flashcards/:flashcardId', async (req, res) => {
    const cardId = id(req.params.flashcardId);
    const b = parse(s.patchFlashcard, req.body);
    res.json(present.flashcard(await patchFlashcard(deps, t(res), cardId, { isAssessment: b.is_assessment, position: b.position, materialUrl: b.material_url })));
  });
  r.delete('/flashcards/:flashcardId', async (req, res) => {
    await deleteFlashcard(deps, t(res), id(req.params.flashcardId));
    res.status(204).end();
  });

  r.post('/courses/:courseId/students', async (req, res) => {
    const courseId = id(req.params.courseId);
    const b = parse(s.enrollStudents, req.body);
    const unique = b.students.filter((x, i) => b.students.findIndex((y) => y.email === x.email) === i); // first one wins
    const out = await enrollStudents(deps, retentionDays, t(res), courseId, unique);
    res.json({ students: out.map((x) => ({ email: x.email, enrolled: x.enrolled, slack_matched: x.slackMatched, restored: x.restored })) });
  });
  r.get('/courses/:courseId/students', async (req, res) => {
    const rows = await listStudents(deps, t(res), id(req.params.courseId));
    res.json({
      students: rows.map(({ enrollment: e, user }) => ({
        student_id: user.id, email: user.email, name: user.fullName, status: e.status,
        enrolled_at: e.enrolledAt.toISOString(), assessment_done_at: e.assessmentDoneAt?.toISOString() ?? null, slack_matched: user.slackId !== null,
      })),
    });
  });
  r.delete('/courses/:courseId/students/:studentId', async (req, res) => {
    await removeStudent(deps, t(res), id(req.params.courseId), id(req.params.studentId));
    res.status(204).end();
  });

  r.get('/courses/:courseId/progress', async (req, res) => {
    const courseId = id(req.params.courseId);
    await ownedCourse(deps, t(res), courseId);
    const p = await courseProgress(deps.db, courseId);
    res.json({ course_id: courseId, class_progress: p.classProgress, students: p.students.map(present.studentProgress) });
  });
  r.get('/courses/:courseId/students/:studentId/progress', async (req, res) => {
    const courseId = id(req.params.courseId);
    const studentId = id(req.params.studentId);
    await ownedCourse(deps, t(res), courseId);
    const p = await studentProgress(deps.db, courseId, studentId);
    res.json({
      course_id: courseId, ...present.studentProgress(p.student),
      cards: p.cards.map((c) => ({ flashcard_id: c.flashcardId, question: c.question, learned: c.learnedAt !== null, correct_streak: c.correctStreak ?? 0, due: c.due?.toISOString() ?? null, last_answer_correct: c.lastAnswerCorrect })),
    });
  });
  return r;
}
