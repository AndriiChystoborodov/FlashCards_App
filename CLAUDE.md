# FlashcardsBot

Spaced-repetition flashcards for company/university courses.
Teachers manage courses through an MCP client (Claude, Codex). Students get cards and answer them in Slack.

## Source of truth

Read these before changing anything:

- `docs/requirements.md` — functional and non-functional requirements, what is out of scope
- `docs/architecture.md` — the system diagram (Mermaid) and how it maps to the MVP
- `docs/data-model-and-api.md` — tables, types and REST endpoints

If code and docs disagree, stop and ask instead of picking one.

## Stack

TypeScript and then I'll decide on other technologies

## Ours scope

Focus on: business logic, data, endpoints, Slack.

## Roadmap

Do one task at a time. Each task ends with passing tests (where it makes sense) and a commit.

Task 1 — Project setup
npm project with "type": "module" (ts-fsrs is ESM), TypeScript strict, module/moduleResolution = nodenext.
Dependencies for the first tasks only: ts-fsrs, @slack/bolt, dotenv, zod; dev: typescript, tsx, vitest, @types/node.
Scripts: dev, test, typecheck.
Env vars validated with zod at startup (src/config/env.ts), matching .env.example.
Folders: src/domain/, src/slack/, src/config/.
Task 2 — Slack spike (Socket Mode)

Goal: prove the full path message → button click → our handler, before any database.

Bolt app in Socket Mode using SLACK_BOT_TOKEN and SLACK_APP_TOKEN.
On start, send one hard-coded test card as a DM to SLACK_TEST_USER_ID.
Message layout: question and numbered options in the message text; buttons only say "1", "2", "3", "Don't know" (button labels are limited to 75 characters).
Button value carries the card id and the chosen option. Never the correct answer.
Click handler: ack() first (Slack waits only 3 seconds), log user id + value, replace the message so it can't be clicked twice.
Second step of the spike: after a right answer, show Hard / Medium / Easy buttons. Their value carries card id + chosen option, so nothing is stored between the two clicks. After a wrong answer or "Don't know", show the right answer instead.

### Task 3 — Flashcard State Calculator

A pure module in `src/domain/` with unit tests next to it. No database, no Express, no Slack imports.

- `CardState` = every field of the ts-fsrs `Card` type, exactly as defined in the installed ts-fsrs version (check the type, don't copy a list from memory), plus our own fields: `correctStreak`, `learnedAt` (Date | null).
- applyAnswer(card, state, answer, now): { state; review }
- A new card's state comes from ts-fsrs `createEmptyCard(now)` plus `correctStreak: 0`, `learnedAt: null`.
- `Answer` = `{ chosenOption: number | null; rating?: 'hard' | 'medium' | 'easy' }`; `null` means "Don't know".
- `Review` = `{ chosenOption, isCorrect, rating: 'easy' | 'hard' | 'medium' | null, reviewedAt }`.
- The database will later store `CardState` one-to-one in `card_states`. The schema follows the calculator, not the other way round.

Rules:

1. Wrong answer or "Don't know" → rating `Again`. The student does not choose an effort level.
2. Right answer → the student chooses Hard / Medium / Easy. Medium maps to FSRS `Good`.
3. The next review date is computed by ts-fsrs (`scheduler.next(card, now, rating)`). Never implement FSRS math by hand.
4. Tests use `enable_fuzz: false`, otherwise intervals are random.
5. `correctStreak` = how many of the most recent answers in a row were right AND rated Medium or Easy. Right + Medium/Easy → +1. Right + Hard → reset to 0 (remembered with difficulty, so not counted). Wrong or "Don't know" (Again) → reset to 0.
6. A card is learned when its `correctStreak >= 2` (the same flashcard, answered in a row on repetition); set `learnedAt = now` the first time it happens. A learned card is not sent again. Keep the threshold in one constant so it is easy to change.
7. Assessment answers go through the same calculator; the assessment rules below decide what happens after.
8. `now` is always passed in, never read from the clock inside the module, so tests are deterministic.

Assessment rules (decided; threshold default may still change):

- At course start the student gets all assessment cards first. When all are answered, set `enrollments.assessment_done_at` and evaluate once.
- An assessment answer counts as passed only if it is right AND rated Easy. Right + Hard or Medium counts as not passed.
- Score = passed assessment cards / all assessment cards.
- Score >= the course's `assessment_pass_threshold` (default 90%) → the student is exempt: no more cards, progress 100%, Slack message that they already know the material.
- Score below the threshold → normal mode. Assessment cards passed as above count as learned immediately and are not sent again (an exception to rule 6). All other cards go through FSRS; new cards are introduced N per day.
- Keep this evaluation in one function in `src/domain/`, separate from the calculator.

Known gaps in the data model the calculator will need:

- `card_states` must store every field of `CardState` (see the calculator shape); the old draft lacks due, reps, lapses, learning_steps and scheduled_days.
- Primary keys: `card_states (user_id, flashcard_id)`, `enrollments (course_id, user_id)`.
- `courses.assessment_pass_threshold` (percent, default 90).
- `enrollments.status` with at least `active`, `exempt`, `completed`.
- `card_states.learned_at` and `card_states.correct_streak`.

## Conventions

- `strict` TypeScript, no `any`.
- Layers: routes → services → db. Routes stay thin; rules live in services and `src/domain/`.

## How to work with me

- Before writing code for a new piece, explain the plan and why in a few sentences and wait for my OK.
- Write the tests for each possible way of resolving code after the implementation.
- Explain any library API or pattern I might not know yet.
- Small commits with clear messages.
