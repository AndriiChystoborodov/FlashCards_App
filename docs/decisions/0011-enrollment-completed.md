# 0011. When an enrollment becomes completed

## Context

`enrollments.status` has `active`, `exempt` and `completed` ([data-model.md](../data-model.md#enrollments)). The first draft never said when `completed` is set, what happens to progress afterwards, or how it relates to `exempt`.

## Options

- Completed only when every card is learned (progress 100%). A student who never finishes stays `active` after the course ends and the scheduler keeps looking at them.
- Completed when every card is learned or when the course reaches `ends_at`, whichever comes first.
- A separate status for "course ended without finishing".

## Choice

The second option. Chosen by the user on 2026-10-24.

- An `active` enrollment becomes `completed` when the student has learned all cards of the course (progress 100%), or when the course reaches `ends_at`, whichever comes first. A manual `POST /courses/:id/stop` ends the course the same way.
- After that no cards are sent and no reminders go out.
- Progress stays as it was at that moment. A completed student can be below 100%. The value is stored in `enrollments.completed_progress` when the status changes, so later changes to the course cannot move it.
- `exempt` stays `exempt` and never becomes `completed`. An exempt student has progress 100 and receives nothing.
- `completed` is final. Cards added to an `active` course after a student completed do not reopen the enrollment.

## Why

The course has a hard end, so every student must reach a final state; otherwise the scheduler and the teacher's view carry unfinished students forever. A single `completed` status for both ways of finishing keeps the status set small, and the stored progress still tells the teacher who finished and who ran out of time. Keeping `exempt` separate preserves the teacher-visible difference between "already knew it" and "went through the course".

## Consequences

- The tick sets `completed` (with `completed_at` and `completed_progress`) when the last card is learned, and for all remaining `active` enrollments when `now >= ends_at`. The course then becomes `finished`. This resolves the earlier open question about `ends_at`.
- Open cards of a completed enrollment are no longer answered: the handler replies that the course is over.
- `POST /courses/:id/flashcards` on a `finished` course returns 409.
- Class progress averages `completed_progress` for completed enrollments, 100 for exempt, and the live value for active ones.
