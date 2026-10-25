# Retain

Spaced-repetition app for company and university courses, delivered in Slack.

Teachers manage courses from an AI agent (Claude, Codex) through an MCP server. Students get one card at a time in a Slack DM and answer with a click. The schedule adapts to each student with the FSRS algorithm, so they see what they don't know more often and what they know less often.

**Status:** design phase. The design is documented; implementation has not started.

## How it works

1. **The teacher creates a course** through the agent: title, end date, flashcards, the students' emails. Some cards are marked for the initial assessment.
2. **The course starts.** Each student gets the assessment cards first. A student who passes the assessment threshold (90% by default, right answers rated Easy) is exempt: they already know the material.
3. **Daily learning.** Everyone else gets cards one at a time. A wrong answer brings the card back the next day; a right answer is rated Hard / Medium / Easy, and FSRS decides when the card comes back.
4. **A card is learned** after two right answers in a row rated Medium or Easy, the last one at least 7 days after the previous answer, so it proves the student remembers after a pause.
5. **The teacher sees progress** for each student and for the class: learned cards out of all cards in the course.

## Stack

TypeScript on Node.js · Express · Slack Bolt · ts-fsrs · PostgreSQL on Supabase · Drizzle ORM · MCP TypeScript SDK v2 · zod 4 · Vitest

Every choice is explained in [docs/decisions/](docs/decisions/).

## Documentation

Start with **[docs/implementation-plan.md](docs/implementation-plan.md)**: the index of all design docs, the MVP shape and the roadmap.

|                                                |                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------- |
| [Requirements](docs/requirements.md)           | what the system must do, definitions, out of scope              |
| [Architecture](docs/architecture.md)           | the system diagram                                              |
| [Data model](docs/data-model.md)               | tables and columns                                              |
| [REST API](docs/rest-api.md)                   | endpoints                                                       |
| [FSRS calculator](docs/fsrs-calculator.md)     | how answers change a card's schedule                            |
| [Scheduler](docs/scheduler.md)                 | which card is sent to whom and when                             |
| [Slack integration](docs/slack/integration.md) | messages, buttons, handlers ([app setup](docs/slack/README.md)) |
| [MCP for teachers](docs/mcp-teacher-api.md)    | the teacher's tools                                             |
| [Walkthrough](docs/walkthrough.md)             | one course from start to finish, with real numbers              |
| [Test plan](docs/test-plan.md)                 | test cases per part                                             |
| [Decisions](docs/decisions/)                   | architecture decision records                                   |

Instructions for AI coding agents are in [AGENTS.md](AGENTS.md).

## Run locally

Task 1 (setup) is done: `npm run dev` validates the env and prints the config. The bot is not built yet (Task 2).

1. Node.js 20 or newer.
2. `npm install`
3. Create a Slack app from [docs/slack/manifest.dev.yaml](docs/slack/manifest.dev.yaml) (see [docs/slack/README.md](docs/slack/README.md)).
4. Copy `.env.example` to `.env` and fill it in.
5. `npm run dev`
