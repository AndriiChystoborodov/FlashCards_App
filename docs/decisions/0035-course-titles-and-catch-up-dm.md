# 0035. Course titles in DMs, 24-hour catch-up rule, finish log line

Source: the user, 2026-10-31, after a real Slack session: a course that had ended on 30 October produced the DM "The course has ended. Your final progress is 0%." one minute after the user started a new course, with no way to tell which course it was about.

## What happened (found in the code and in `retain_dev`)

The tick finishes every active course whose `ends_at` has passed (`finishEndedCourses`, `src/services/scheduler.ts`), however long ago, and its first pass is one interval after the server starts. The server had been off since 27 October, so the first tick after the restart finished the old course and sent its "ended" DM. The user was enrolled in the new course seconds later, and its first card arrived right after.

## Choices

| # | choice | why |
| --- | --- | --- |
| 1 | The DMs the scheduler and the start flow send name the course: `The course "<title>" has started for you. ...`, `... has ended. Your final progress is N%.`, the congratulation and the exempt message. `restored`, `expired` and `removed` are unchanged | the user's list; a student can be in several courses and the chat has no other cue |
| 2 | The title is teacher text and is escaped with `escapeMrkdwn` before it goes into Slack's mrkdwn | `<!channel>` and `<@U..>` must not fire |
| 3 | `finishCourse(deps, id, { catchUp: true })`, used only by `finishEndedCourses`, sends the "course ended" DM only if `ends_at` is at most 24 hours old (`ENDED_DM_MAX_AGE_MS`). Older courses are still finished: enrollments completed, open cards replaced with text only, no DM. A stop (`stopCourse`) never passes `catchUp`, so it always sends the DM | a student must not hear about a course that ended days ago |
| 4 | One log line per finished course: `course <id> finished: completed=N replaced=M failed=K`; `replaced` counts the open cards replaced, `failed` the failed replacements plus failed DMs. A course that was already finished logs nothing | the user's request; shows whether a card replacement failed |
| 5 | Not changed: the tick timing (first pass one interval after the start) and no startup pass | the user's instruction |

## Tests and scenario

`S28a` to `S28d` in `src/services/scheduler.test.ts`; scenario step 24 (two courses finished by one tick, 49 hours and 1 hour after `ends_at`). The existing tests and scenario steps use the new texts. The trace baseline differs in the changed DM texts and in step 24; it is accepted only after the user has seen the diff and after the live test.

## Known limits

- Messages already sent are not changed.
- The cut-off is a constant (24 hours), not an env variable.
- A course finished by a catch-up older than 24 hours leaves the student without any message that it ended.
