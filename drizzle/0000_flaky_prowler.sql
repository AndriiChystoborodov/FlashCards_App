CREATE TABLE "card_states" (
	"user_id" uuid NOT NULL,
	"flashcard_id" uuid NOT NULL,
	"due" timestamp with time zone NOT NULL,
	"stability" double precision NOT NULL,
	"difficulty" double precision NOT NULL,
	"elapsed_days" integer NOT NULL,
	"scheduled_days" integer NOT NULL,
	"learning_steps" integer NOT NULL,
	"reps" integer NOT NULL,
	"lapses" integer NOT NULL,
	"state" smallint NOT NULL,
	"last_review" timestamp with time zone,
	"correct_streak" integer DEFAULT 0 NOT NULL,
	"learned_at" timestamp with time zone,
	"introduced_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"message_channel" text,
	"message_ts" text,
	CONSTRAINT "card_states_user_id_flashcard_id_pk" PRIMARY KEY("user_id","flashcard_id"),
	CONSTRAINT "card_states_state_check" CHECK ("card_states"."state" between 0 and 3)
);
--> statement-breakpoint
ALTER TABLE "card_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"title" text NOT NULL,
	"material_url" text NOT NULL,
	"status" text NOT NULL,
	"assessment_pass_threshold" integer DEFAULT 90 NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"scheduled_start_at" timestamp with time zone,
	"starts_at" timestamp with time zone,
	CONSTRAINT "courses_status_check" CHECK ("courses"."status" in ('draft', 'active', 'finished'))
);
--> statement-breakpoint
ALTER TABLE "courses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "enrollments" (
	"course_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_progress" numeric,
	"enrolled_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"assessment_done_at" timestamp with time zone,
	"assessment_score" numeric,
	CONSTRAINT "enrollments_course_id_user_id_pk" PRIMARY KEY("course_id","user_id"),
	CONSTRAINT "enrollments_status_check" CHECK ("enrollments"."status" in ('active', 'exempt', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "enrollments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "flashcards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"correct_option" integer NOT NULL,
	"is_assessment" boolean NOT NULL,
	"material_url" text,
	"position" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flashcards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"flashcard_id" uuid NOT NULL,
	"chosen_option" integer,
	"is_correct" boolean NOT NULL,
	"rating" text,
	"reviewed_at" timestamp with time zone NOT NULL,
	"delivery_sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reviews_delivery_unique" UNIQUE("user_id","flashcard_id","delivery_sent_at"),
	CONSTRAINT "reviews_rating_check" CHECK ("reviews"."rating" in ('hard', 'medium', 'easy'))
);
--> statement-breakpoint
ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"slack_id" text,
	"slack_dm_channel" text,
	"tz" text,
	"api_token_hash" text,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_api_token_hash_unique" UNIQUE("api_token_hash"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('teacher', 'student'))
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "card_states" ADD CONSTRAINT "card_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_states" ADD CONSTRAINT "card_states_flashcard_id_flashcards_id_fk" FOREIGN KEY ("flashcard_id") REFERENCES "public"."flashcards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flashcards" ADD CONSTRAINT "flashcards_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_flashcard_id_flashcards_id_fk" FOREIGN KEY ("flashcard_id") REFERENCES "public"."flashcards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_states_user_id_due_idx" ON "card_states" USING btree ("user_id","due") WHERE "card_states"."learned_at" is null;--> statement-breakpoint
CREATE INDEX "enrollments_user_id_idx" ON "enrollments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "flashcards_course_id_position_idx" ON "flashcards" USING btree ("course_id","position");