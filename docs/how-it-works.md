# How it works (one page)

For a live walkthrough: where everything goes and how, as built today (Tasks 1 to 8a). The rules are not repeated here; each section links to the doc that owns them.

## 1. Components

```mermaid
flowchart LR
  T["Teacher (REST client)"] -->|"Bearer token"| API["REST API<br/>src/api"]
  API --> SVC["Services<br/>src/services"]
  TICK["Tick<br/>src/services/tick.ts"] --> SCH["Scheduler<br/>src/services/scheduler.ts"]
  H["Bolt handlers<br/>src/slack/handlers.ts"] --> ANS["Answer service<br/>src/services/answer.ts"]
  H --> SCH
  SVC --> SCH
  ANS --> CALC["Calculator and assessment<br/>src/domain"]
  SCH --> NEXT["next and quota<br/>src/domain, src/db/selection.ts"]
  SCH --> PORT["SlackPort<br/>src/slack/port.ts"]
  PORT --> WEB["Slack adapter<br/>src/slack/web.ts"]
  WEB --> SLACK(("Slack"))
  SLACK -->|"button click"| H
  ANS --> DB[("Postgres<br/>src/db, Drizzle")]
  SCH --> DB
  SVC --> DB
  CLOCK["Clock<br/>src/clock.ts"] -.->|"all time comes from here"| SVC
```

- `src/index.ts` wires it: HTTP server (`startServer`), Slack (Bolt in Socket Mode), the tick. Details: [implementation-plan.md](implementation-plan.md).
- Services and the scheduler get time only from the injected clock, which is why the scenario can advance days. The calculator in `src/domain` has no database, Express or Slack imports.
- The scheduler talks to Slack only through `SlackPort`. Tests and the scenario use `FakeSlack` (`src/slack/fake.ts`).

## 2. Teacher sets up a course

```mermaid
sequenceDiagram
  actor Teacher
  participant API as REST API
  participant DB as Postgres
  participant Slack
  Teacher->>API: POST /courses
  API->>DB: courses row, status draft
  Teacher->>API: POST /courses/id/flashcards
  API->>DB: flashcards rows, is_assessment marks the entry test
  Teacher->>API: POST /courses/id/students with emails
  API->>Slack: users.lookupByEmail
  Slack-->>API: slack id and time zone
  API->>DB: users row, slack_id and tz, enrollments row
  Teacher->>API: POST /courses/id/start
  API->>DB: courses status active, starts_at
  API->>Slack: start message to each enrolled student
  API->>DB: card_states row per student, first assessment card claimed
  API->>Slack: first card posted
  API->>DB: message_channel, message_ts, users.slack_dm_channel
```

Routes, errors and ownership rules: [rest-api.md](rest-api.md). Tables: [data-model.md](data-model.md).

## 3. Life of one card

```mermaid
sequenceDiagram
  actor Student
  participant Slack
  participant H as Bolt handlers
  participant A as Answer service
  participant C as Calculator
  participant S as Scheduler
  participant DB as Postgres
  Note over S,DB: A tick, a course start or the previous answer triggers sendNext
  S->>DB: next picks the card, claim sets card_states.sent_at
  S->>Slack: postCard through the adapter
  S->>DB: save message_channel and message_ts
  Student->>Slack: clicks an option
  Slack->>H: block_actions
  H->>Slack: ack first
  H->>A: previewAnswer, writes nothing
  alt right answer
    H->>Slack: replace message with the rating prompt
    Student->>Slack: clicks Hard, Medium or Easy
    Slack->>H: block_actions
    H->>Slack: ack first
  end
  H->>A: submitAnswer
  A->>DB: one transaction starts
  A->>DB: insert review, unique delivery key
  A->>C: applyAnswer card, state, answer, now
  C-->>A: new card state and review
  A->>DB: update card_states, clear sent_at, clamp due
  A->>DB: last assessment card, evaluate once and set learned flags
  A-->>H: result
  H->>Slack: replace the message with the outcome
  H->>S: afterAnswer
  S->>DB: completion check
  S->>Slack: next card, or the exempt or completed message
```

- A wrong answer or "Don't know" skips the rating step and goes straight to `submitAnswer`.
- Every click is checked against the clicking Slack user, the stored delivery and the course state; refusals get a text and change nothing.
- Rules and numbers: [scheduler.md](scheduler.md) (what is sent when), [fsrs-calculator.md](fsrs-calculator.md) (what an answer changes), [slack/integration.md](slack/integration.md) (messages and handlers), [decision 0029](decisions/0029-task8-slack-wiring-choices.md).

## 4. One card across days

Real numbers from `npm run scenario` (steps 11, 14, 18), Europe/Zurich, course ends Friday 16 January:

```mermaid
timeline
  title card-1 for Ann
  Mon 5 Jan : Answers Medium at 14h06
                  : FSRS schedules Wed 14h06
                  : Streak 1
  Wed 7 Jan : Asked again at 09h15, answers Medium
                  : FSRS would schedule Sun 18 Jan
                  : Clamped to the end of Thu 15 Jan, streak 2, not learned yet
  Thu 15 Jan : Asked again at 09h20, 8 days later
                   : Medium, streak 2 and the gap is at least 7 days
                   : Learned, never sent again
```

Why the clamp and the 7-day gap: [fsrs-calculator.md](fsrs-calculator.md) and [decision 0015](decisions/0015-learned-needs-retention-gap.md).

To see the whole 12-day run as one picture, run `npm run scenario` and then `npm run scenario:report`, and open `reports/scenario.html`. It shows each card on each day (sent, answered Hard/Medium/Easy, waiting, clamped, learned), cards introduced and learned per day with the 40% outcome, and the exempt student. Details: [scenario.md](scenario.md#report).

## 5. File map

| Where | What lives there |
| --- | --- |
| `src/index.ts` | starts the HTTP server, Slack and the tick |
| `src/config/` | environment variables, validated at startup (zod) |
| `src/clock.ts` | the injectable clock (system and controllable) |
| `src/domain/` | pure rules: calculator, assessment, quota, local-day helpers |
| `src/db/` | Drizzle schema, repositories, mappers, reset script |
| `src/services/` | the use cases: answer, scheduler, tick, courses, enrollment, progress |
| `src/api/` | Express app, token auth, zod schemas, teacher and student routers |
| `src/slack/` | port, real adapter, Bolt handlers, card messages, fake |
| `scripts/` | `scenario.ts` (end-to-end check), `scenario-report.ts` (HTML picture of it), `demo-seed.ts`, `issue-teacher-token.ts`, `dev-api.ts` |
| `drizzle/` | generated SQL migrations |
| `docker-compose.yml` | local Postgres |
| `docs/` | design docs ([implementation-plan.md](implementation-plan.md) is the index) and `decisions/` |

How to run the scenario: [scenario.md](scenario.md). How to try it in a real Slack: [slack/live-run.md](slack/live-run.md).
