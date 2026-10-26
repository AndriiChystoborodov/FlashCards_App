import { z } from 'zod';

// Request bodies of docs/rest-api.md. Strict objects: an unknown key is a 400, not silently dropped.
// Postgres text and jsonb reject NUL, so it is a 400 here instead of a 500 there.
const str = () => z.string().refine((s) => !s.includes('\0'), 'NUL is not allowed');
const url = z.url({ protocol: /^https?$/ }).max(2000).refine((s) => !s.includes('\0'), 'NUL is not allowed');
// Years outside 2000 to 9999 are mistakes, and Postgres refuses year 0.
const date = z.iso.datetime({ offset: true }).transform((s) => new Date(s)).refine((d) => d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 9999, 'date out of range');
const threshold = z.int().min(1).max(100);

export const idParam = z.guid();

export const createCourse = z.strictObject({
  title: str().trim().min(1).max(200),
  material_url: url,
  ends_at: date,
  scheduled_start_at: date.nullable().optional(),
  assessment_pass_threshold: threshold.optional(),
});

export const patchCourse = z
  .strictObject({
    title: str().trim().min(1).max(200),
    material_url: url,
    ends_at: date,
    scheduled_start_at: date.nullable(),
    assessment_pass_threshold: threshold,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');

const MAX_CARD_CHARS = 3000; // Slack message text limit (rest-api.md "Validation")
const flashcard = z
  .strictObject({
    question: str().min(1),
    options: z.array(str().min(1)).min(2).max(9),
    correct_option: z.int().min(0),
    material_url: url.nullable().optional(),
    is_assessment: z.boolean().default(false),
  })
  .refine((c) => c.correct_option < c.options.length, { message: 'correct_option is outside the options', path: ['correct_option'] })
  .refine((c) => c.question.length + c.options.reduce((n, o) => n + o.length, 0) <= MAX_CARD_CHARS, { message: `question and options together must be at most ${MAX_CARD_CHARS} characters`, path: ['question'] });

export const addFlashcards = z.strictObject({ flashcards: z.array(flashcard).min(1).max(100) });

export const patchFlashcard = z
  .strictObject({ is_assessment: z.boolean(), position: z.int().min(1), material_url: url.nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');

export const enrollStudents = z.strictObject({
  students: z
    .array(z.strictObject({ email: str().trim().toLowerCase().pipe(z.email().max(320)), name: str().trim().min(1).max(200) }))
    .min(1)
    .max(500),
});

export const review = z.strictObject({
  chosen_option: z.int().min(0).nullable(),
  rating: z.enum(['hard', 'medium', 'easy']).optional(),
});
