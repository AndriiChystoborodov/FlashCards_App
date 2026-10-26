import express, { Router } from 'express';
import type { SchedulerDeps } from '../services/scheduler.js';
import { answerCard, coursesFor } from '../services/studentReview.js';
import { id, parse } from './errors.js';
import * as s from './schemas.js';

/**
 * No authentication (decision 0018): mounted only when STUDENT_ROUTES_ENABLED is true, never in production.
 * `correct_option` appears only in the answer response, after the answer is stored.
 */
export function studentRouter(deps: SchedulerDeps): Router {
  const r = Router();
  r.use('/users', express.json({ limit: '10kb' }));
  r.post('/users/:userId/flashcards/:flashcardId/reviews', async (req, res) => {
    const userId = id(req.params.userId);
    const flashcardId = id(req.params.flashcardId);
    const b = parse(s.review, req.body);
    const a = await answerCard(deps, userId, flashcardId, b.chosen_option, b.rating);
    res.json({ is_correct: a.isCorrect, correct_option: a.correctOption, rating: a.rating, material_url: a.materialUrl, progress: a.progress });
  });
  r.get('/users/:userId/courses', async (req, res) => {
    const rows = await coursesFor(deps, id(req.params.userId));
    res.json({
      courses: rows.map(({ course: c, enrollment: e, progress }) => ({ course_id: c.id, title: c.title, status: c.status, progress, assessment_done: e.assessmentDoneAt !== null, enrollment_status: e.status })),
    });
  });
  return r;
}
