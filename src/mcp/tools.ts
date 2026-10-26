import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { ApiError, type RetainApi } from './client.js';

// The tools of docs/mcp-teacher-api.md: one per REST route of docs/rest-api.md. The REST API stays the authority for every rule;
// the schemas below repeat the limits so the model gets a clear error before any HTTP call, and the descriptions say the rules a model would guess wrong.

const id = (what: string) => z.guid().describe(`${what} (uuid)`);
const courseId = id('course_id from create_course or list_courses');
const iso = z.iso.datetime({ offset: true });
const url = z.url({ protocol: /^https?$/ }).max(2000);
const confirmed = (effect: string) =>
  z.literal(true).describe(`Must be true. Set it only after the user has said yes in this conversation to: ${effect}. If they have not, ask them first and do not call this tool.`);

const flashcard = z.strictObject({
  question: z.string().min(1).describe('Plain text. Question and all options together at most 2,900 characters.'),
  options: z.array(z.string().min(1)).min(2).max(9).describe('2 to 9 answer options, in the order shown to the student.'),
  correct_option: z.int().min(0).describe('0-based index into options (0 is the first option).'),
  material_url: url.nullable().optional().describe('Link shown to the student after answering.'),
  is_assessment: z.boolean().default(false).describe('true only while the course is a draft; adding an assessment card to a running course is refused (assessment_closed).'),
});

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodType;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run(args: never, api: RetainApi): Promise<unknown>;
}

function def<S extends z.ZodObject>(t: { name: string; description: string; input: S; annotations: ToolDef['annotations']; run(a: z.infer<S>, api: RetainApi): Promise<unknown> }): ToolDef {
  return t as unknown as ToolDef;
}

const c = (a: { course_id: string }) => `/courses/${encodeURIComponent(a.course_id)}`;
const noInput = z.strictObject({});
const byCourse = z.strictObject({ course_id: courseId });
const READ = { readOnlyHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false } as const;
const DESTROY = { readOnlyHint: false, destructiveHint: true } as const;

const courseFields = {
  title: z.string().trim().min(1).max(200),
  material_url: url.describe('Link to the course material.'),
  ends_at: iso.describe('ISO 8601 with a time zone, for example 2026-12-20T22:59:00Z. Cards stop being sent at this moment.'),
  scheduled_start_at: iso.nullable().describe('Only stored. It does NOT start the course; start_course does.'),
  assessment_pass_threshold: z.int().min(1).max(100).describe('Percent of assessment cards a student must pass (right and rated Easy) to be exempt. Default 90.'),
};

export const tools: ToolDef[] = [
  def({
    name: 'create_course',
    description: 'Create a course in status draft. Nothing is sent to anyone. Next: add_flashcards, enroll_students, then start_course. ends_at is required.',
    input: z.strictObject({ title: courseFields.title, material_url: courseFields.material_url, ends_at: courseFields.ends_at, scheduled_start_at: courseFields.scheduled_start_at.optional(), assessment_pass_threshold: courseFields.assessment_pass_threshold.optional() }),
    annotations: WRITE,
    run: (a, api) => api.request('POST', '/courses', a),
  }),
  def({ name: 'list_courses', description: 'List your courses with card_count, assessment_card_count and student_count.', input: noInput, annotations: READ, run: (_a, api) => api.request('GET', '/courses') }),
  def({ name: 'get_course', description: 'One course with its status (draft, active, finished) and counts.', input: byCourse, annotations: READ, run: (a, api) => api.request('GET', c(a)) }),
  def({
    name: 'update_course',
    description:
      'Change title, material_url, scheduled_start_at, ends_at or assessment_pass_threshold; at least one field. Draft and active only (a finished course is read-only: course_finished). ' +
      'On an active course the threshold cannot be changed at all (threshold_locked, even to the same value) and ends_at can only move later (ends_at_shortened).',
    input: z.strictObject({ course_id: courseId, title: courseFields.title.optional(), material_url: courseFields.material_url.optional(), ends_at: courseFields.ends_at.optional(), scheduled_start_at: courseFields.scheduled_start_at.optional(), assessment_pass_threshold: courseFields.assessment_pass_threshold.optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: ({ course_id, ...body }, api) => api.request('PATCH', c({ course_id }), body),
  }),
  def({
    name: 'start_course',
    description:
      'Start a draft course. THIS MESSAGES STUDENTS IMMEDIATELY: every enrolled student with a Slack account gets a Slack DM and their first assessment card at once, and it cannot be undone. ' +
      'After the start, flashcards can no longer be edited or deleted, only added (no assessment cards), the threshold is locked and ends_at can only move later. ' +
      'BEFORE calling: (1) call list_flashcards and show the user ALL cards with their correct options, (2) ask the user to confirm starting the course, (3) only then call this with confirmed: true. ' +
      'Refused when the course has no cards (no_cards), ends_at is not in the future (ends_at_passed) or it is not a draft (course_not_draft).',
    input: z.strictObject({ course_id: courseId, confirmed: confirmed('start this course, which messages its students now, after they have seen all cards and correct options') }),
    annotations: DESTROY,
    run: ({ course_id }, api) => api.request('POST', `${c({ course_id })}/start`),
  }),
  def({
    name: 'stop_course',
    description:
      'Stop an active course now. THIS MESSAGES STUDENTS: every active student gets the "course ended" DM with their final progress; no more cards are sent and it cannot be undone. ' +
      'Ask the user first, then call with confirmed: true. Only an active course can be stopped (course_not_active).',
    input: z.strictObject({ course_id: courseId, confirmed: confirmed('stop this course, which messages its students and ends it for good') }),
    annotations: DESTROY,
    run: ({ course_id }, api) => api.request('POST', `${c({ course_id })}/stop`),
  }),
  def({
    name: 'delete_course',
    description: 'Permanently delete a DRAFT course with its flashcards and enrollments. A running or finished course cannot be deleted (course_not_draft); use stop_course. Ask the user first, then call with confirmed: true.',
    input: z.strictObject({ course_id: courseId, confirmed: confirmed('permanently delete this draft course with its cards and enrollments') }),
    annotations: DESTROY,
    run: ({ course_id }, api) => api.request('DELETE', c({ course_id })),
  }),
  def({
    name: 'add_flashcards',
    description:
      'Add 1 to 100 flashcards in one call (they go to the end). Each has 2 to 9 options and a 0-based correct_option. Question plus all options together at most 2,900 characters (Slack limit). ' +
      'Question and options can NEVER be edited after adding, so check them first. is_assessment (default false) may be true only while the course is a draft; on a running course it is refused (assessment_closed). ' +
      'A finished course refuses new cards (course_finished). Cards added to a running course join the pool and are introduced over the remaining days.',
    input: z.strictObject({ course_id: courseId, flashcards: z.array(flashcard).min(1).max(100) }),
    annotations: WRITE,
    run: ({ course_id, flashcards }, api) => api.request('POST', `${c({ course_id })}/flashcards`, { flashcards }),
  }),
  def({ name: 'list_flashcards', description: 'List the cards of a course in order, including correct_option and is_assessment. Teacher view only; students never see correct_option before answering.', input: byCourse, annotations: READ, run: (a, api) => api.request('GET', `${c(a)}/flashcards`) }),
  def({
    name: 'update_flashcard',
    description:
      'Change is_assessment, position (1-based) or material_url of one card. DRAFT COURSES ONLY: once the course has started this is refused (course_not_draft). Question, options and correct_option can never be changed; to fix a typo in a draft, delete the card and add a new one.',
    input: z.strictObject({ flashcard_id: id('flashcard_id from list_flashcards'), is_assessment: z.boolean().optional(), position: z.int().min(1).optional(), material_url: url.nullable().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: ({ flashcard_id, ...body }, api) => api.request('PATCH', `/flashcards/${encodeURIComponent(flashcard_id)}`, body),
  }),
  def({
    name: 'delete_flashcard',
    description: 'Delete one card. DRAFT COURSES ONLY: once the course has started this is refused (course_not_draft). Not undoable.',
    input: z.strictObject({ flashcard_id: id('flashcard_id from list_flashcards') }),
    annotations: DESTROY,
    run: (a, api) => api.request('DELETE', `/flashcards/${encodeURIComponent(a.flashcard_id)}`),
  }),
  def({
    name: 'enroll_students',
    description:
      'Enroll up to 500 students by email and name. Emails are matched to Slack accounts in the workspace of the bot; slack_matched: false means no Slack account was found and that student gets no cards until the email matches. ' +
      'On a RUNNING course each newly enrolled student gets a DM and the first card at once. A student removed less than 14 days ago is restored with their progress (restored: true). A finished course refuses (course_finished).',
    input: z.strictObject({ course_id: courseId, students: z.array(z.strictObject({ email: z.email().max(320), name: z.string().trim().min(1).max(200) })).min(1).max(500) }),
    annotations: WRITE,
    run: ({ course_id, students }, api) => api.request('POST', `${c({ course_id })}/students`, { students }),
  }),
  def({ name: 'list_students', description: 'Enrolled students of a course: status (active, exempt, completed), assessment_done_at, slack_matched. Removed students are not listed. Large on big classes.', input: byCourse, annotations: READ, run: (a, api) => api.request('GET', `${c(a)}/students`) }),
  def({
    name: 'remove_student',
    description:
      'Remove a student from a course (soft delete). They get no more cards or reminders, drop out of class progress and their open card message becomes "expired". Re-enrolling the same email within 14 days restores their progress; after that it is deleted. Repeating is harmless. Ask the user first, then call with confirmed: true.',
    input: z.strictObject({ course_id: courseId, student_id: id('student_id from list_students'), confirmed: confirmed('remove this student from the course') }),
    annotations: DESTROY,
    run: ({ course_id, student_id }, api) => api.request('DELETE', `${c({ course_id })}/students/${encodeURIComponent(student_id)}`),
  }),
  def({
    name: 'get_class_progress',
    description: 'Class progress (average over present students) and one row per student: status, progress %, learned, total, assessment_done, waiting_since. A waiting_since many days old means the student has an unanswered card and is blocked. Large on big classes.',
    input: byCourse,
    annotations: READ,
    run: (a, api) => api.request('GET', `${c(a)}/progress`),
  }),
  def({
    name: 'get_student_progress',
    description: 'One student\'s progress with a row per card: learned, correct_streak, due, last_answer_correct.',
    input: z.strictObject({ course_id: courseId, student_id: id('student_id from list_students') }),
    annotations: READ,
    run: (a, api) => api.request('GET', `${c(a)}/students/${encodeURIComponent(a.student_id)}/progress`),
  }),
];

const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

/** API errors reach the model as `code: message`; anything else is reported by kind only, so no URL, header or token can leak through an exception. */
export async function runTool(t: ToolDef, args: unknown, api: RetainApi): Promise<CallToolResult> {
  try {
    return text(await t.run(args as never, api));
  } catch (err) {
    if (err instanceof ApiError) return failure(`${err.code}: ${err.message}`);
    return failure('internal_error: the tool failed unexpectedly.');
  }
}

/** Transport-independent (decision 0007): the entry file owns stdio and the REST client. */
export function registerTools(server: McpServer, api: RetainApi): void {
  for (const t of tools) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.input as z.ZodObject, annotations: t.annotations }, (args: unknown) => runTool(t, args, api));
  }
}
