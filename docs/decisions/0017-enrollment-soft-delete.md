# 0017. Removing a student is a soft delete with 14 days of retention

## Context

`DELETE /courses/:courseId/students/:studentId` was only "remove an enrollment". A teacher can remove a student by mistake, or the student returns. A hard delete would lose all progress ([data-model.md](../data-model.md#enrollments)), while keeping everything forever is not wanted for personal data.

## Options

- Hard delete at once.
- Soft delete with a restore window, then a hard delete.
- Soft delete forever.

## Choice

The second option. Chosen by the user on 2026-10-24.

**Removal.** `DELETE /courses/:courseId/students/:studentId` sets `enrollments.removed_at = now`. From that moment:

- the student gets no cards and no reminders;
- the student is excluded from class progress, `student_count`, the student list and `GET /users/:userId/courses`;
- an open Slack card message is replaced with "expired" (`chat.update` with the stored `message_channel` and `message_ts`), and the open card is voided: `sent_at`, `message_ts`, `reminded_at` and `reminder_count` are cleared, so restoring does not leave a dead message. A late click gets "You are no longer enrolled in this course";
- `status`, `assessment_*`, `card_states` and `reviews` are left untouched.

The call is idempotent: removing an already removed student changes nothing (204).

**Restore.** Enrolling the same email again within `REMOVED_RETENTION_DAYS` clears `removed_at` and restores all progress. The student continues from the saved state: overdue cards are due again, and the open card, if any, is sent again. The result of `POST /courses/:courseId/students` marks the student `restored: true`, and a DM tells the student they are back.

**Cleanup.** A daily job in the scheduler tick hard-deletes, for enrollments with `removed_at < now - REMOVED_RETENTION_DAYS` (default 14 days): the `reviews` and `card_states` of that student for the flashcards of that course, then the `enrollments` row, in one transaction. The `users` row stays (the student may be in other courses). After that, enrolling the same email again creates a new enrollment from scratch, with the assessment first.

## Why

A mistaken removal is cheap to undo, and the personal data of someone who really left is deleted after two weeks. Keeping `status` and `card_states` unchanged makes restore trivial: clear one column.

## Consequences

- Env: `REMOVED_RETENTION_DAYS` (default 14), to add to `.env.example` and the zod env schema.
- Every progress, scheduling and listing query must filter `removed_at is null`; one shared predicate in the repository, covered by tests.
- A removed student in a course that ends before restore: the tick leaves their enrollment alone (it is not completed at `ends_at`) and the cleanup removes it.
- The teacher cannot list removed students in the MVP; add `include_removed` later if needed.
- Deleting a `draft` course with removed students deletes the course data as before.
