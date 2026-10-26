import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fullName: text('full_name').notNull(),
    email: text('email').notNull().unique(),
    role: text('role').notNull(),
    slackId: text('slack_id'),
    slackDmChannel: text('slack_dm_channel'),
    tz: text('tz'),
    apiTokenHash: text('api_token_hash').unique(),
  },
  (t) => [
    check('users_role_check', sql`${t.role} in ('teacher', 'student')`),
    // A Slack click is mapped to a user by this id, so two users must never share one (nulls may repeat).
    uniqueIndex('users_slack_id_key').on(t.slackId),
  ],
).enableRLS();

export const courses = pgTable(
  'courses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    materialUrl: text('material_url').notNull(),
    status: text('status').notNull(),
    assessmentPassThreshold: integer('assessment_pass_threshold').notNull().default(90),
    endsAt: tstz('ends_at').notNull(),
    scheduledStartAt: tstz('scheduled_start_at'),
    startsAt: tstz('starts_at'),
  },
  (t) => [check('courses_status_check', sql`${t.status} in ('draft', 'active', 'finished')`)],
).enableRLS();

export const enrollments = pgTable(
  'enrollments',
  {
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull(),
    completedAt: tstz('completed_at'),
    completedProgress: numeric('completed_progress', { mode: 'number' }),
    enrolledAt: tstz('enrolled_at').notNull(),
    removedAt: tstz('removed_at'),
    assessmentDoneAt: tstz('assessment_done_at'),
    assessmentScore: numeric('assessment_score', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.courseId, t.userId] }),
    check('enrollments_status_check', sql`${t.status} in ('active', 'exempt', 'completed')`),
    index('enrollments_user_id_idx').on(t.userId),
  ],
).enableRLS();

export const flashcards = pgTable(
  'flashcards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    question: text('question').notNull(),
    options: jsonb('options').$type<string[]>().notNull(),
    correctOption: integer('correct_option').notNull(),
    isAssessment: boolean('is_assessment').notNull(),
    materialUrl: text('material_url'),
    position: integer('position').notNull(),
  },
  (t) => [index('flashcards_course_id_position_idx').on(t.courseId, t.position)],
).enableRLS();

export const cardStates = pgTable(
  'card_states',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    flashcardId: uuid('flashcard_id')
      .notNull()
      .references(() => flashcards.id),
    // CardState: ts-fsrs Card fields
    due: tstz('due').notNull(),
    stability: doublePrecision('stability').notNull(),
    difficulty: doublePrecision('difficulty').notNull(),
    elapsedDays: integer('elapsed_days').notNull(),
    scheduledDays: integer('scheduled_days').notNull(),
    learningSteps: integer('learning_steps').notNull(),
    reps: integer('reps').notNull(),
    lapses: integer('lapses').notNull(),
    state: smallint('state').notNull(),
    lastReview: tstz('last_review'),
    // CardState: our fields
    correctStreak: integer('correct_streak').notNull().default(0),
    learnedAt: tstz('learned_at'),
    // scheduler-only columns
    introducedAt: tstz('introduced_at').notNull(),
    sentAt: tstz('sent_at'),
    remindedAt: tstz('reminded_at'),
    reminderCount: integer('reminder_count').notNull().default(0),
    messageChannel: text('message_channel'),
    messageTs: text('message_ts'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.flashcardId] }),
    check('card_states_state_check', sql`${t.state} between 0 and 3`),
    index('card_states_user_id_due_idx').on(t.userId, t.due).where(sql`${t.learnedAt} is null`),
  ],
).enableRLS();

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    flashcardId: uuid('flashcard_id')
      .notNull()
      .references(() => flashcards.id),
    chosenOption: integer('chosen_option'),
    isCorrect: boolean('is_correct').notNull(),
    rating: text('rating'),
    reviewedAt: tstz('reviewed_at').notNull(),
    deliverySentAt: tstz('delivery_sent_at').notNull(),
  },
  (t) => [
    unique('reviews_delivery_unique').on(t.userId, t.flashcardId, t.deliverySentAt),
    check('reviews_rating_check', sql`${t.rating} in ('hard', 'medium', 'easy')`),
  ],
).enableRLS();
