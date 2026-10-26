import type { CourseWithCounts } from '../db/courses.js';
import type { FlashcardRow } from '../db/flashcards.js';
import type { StudentProgress } from '../services/progress.js';

// snake_case JSON shapes of docs/rest-api.md.
const iso = (d: Date | null) => d?.toISOString() ?? null;

export const course = (c: CourseWithCounts) => ({
  course_id: c.id,
  title: c.title,
  material_url: c.materialUrl,
  status: c.status,
  assessment_pass_threshold: c.assessmentPassThreshold,
  ends_at: iso(c.endsAt),
  scheduled_start_at: iso(c.scheduledStartAt),
  starts_at: iso(c.startsAt),
  card_count: c.cardCount,
  assessment_card_count: c.assessmentCardCount,
  student_count: c.studentCount,
});

/** Teacher view: includes `correct_option`. Never used on a student route. */
export const flashcard = (f: FlashcardRow) => ({
  flashcard_id: f.id,
  question: f.question,
  options: f.options,
  correct_option: f.correctOption,
  material_url: f.materialUrl,
  is_assessment: f.isAssessment,
  position: f.position,
});

export const studentProgress = (s: StudentProgress) => ({
  student_id: s.studentId,
  name: s.name,
  status: s.status,
  progress: s.progress,
  learned: s.learned,
  total: s.total,
  assessment_done: s.assessmentDone,
  waiting_since: iso(s.waitingSince),
});
