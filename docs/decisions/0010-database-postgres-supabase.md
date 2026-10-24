# 0010. Database: PostgreSQL hosted on Supabase

Status: accepted. Chosen by the user on 2026-10-24. Adapted to this project after a check of the first draft (see "Corrections made in review" at the end).

## Context

The data is relational ([data-model.md](../data-model.md)). The model needs:

- composite primary keys (`card_states (user_id, flashcard_id)`, `enrollments (course_id, user_id)`) and foreign keys;
- one transaction per answer across `card_states`, `reviews` and `enrollments` ([scheduler.md](../scheduler.md#answer-path));
- joins and aggregates: "the student's next due card in this course" (`card_states` JOIN `flashcards`, ordered by `due`), "class progress" (an aggregate over all students and cards);
- `timestamptz`, `jsonb`, and a claim query for sending cards (`UPDATE ... WHERE sent_at IS NULL`, `FOR UPDATE SKIP LOCKED` if we ever run more than one instance).

Nobody talks to the database directly. Teachers go through MCP, then the REST API; students go through Slack, then our server. All rules (FSRS, scheduling, status checks) live in our code, so we need a database, not a backend-as-a-service.

One database for the MVP, about 1,000 students in one class, one developer. One tenant per company or university ([requirements.md](../requirements.md)).

## Options

| | Supabase | Firebase (Firestore) | Other managed Postgres (Neon, Railway) | Self-hosted Postgres | SQLite |
| --- | --- | --- | --- | --- | --- |
| Database | PostgreSQL | Document NoSQL | PostgreSQL | PostgreSQL | Embedded SQL |
| Joins, foreign keys, multi-table transactions | Yes | No joins, no foreign keys; data must be duplicated | Yes | Yes | Yes |
| Connect from our server | Plain `DATABASE_URL`, any Postgres library | Their SDK only | Plain `DATABASE_URL` | Plain `DATABASE_URL` | Local file |
| Operations (backups, updates) | Managed | Managed | Managed | On us | On us |
| Ready-made auth for teachers later | Supabase Auth | Firebase Auth | No | No | No |
| Vendor lock-in | Low: open source, standard Postgres | High | Low | None | None |
| Concurrency | Full | Full | Full | Full | Single writer, no `SKIP LOCKED` |

Firebase also has Data Connect (PostgreSQL on Cloud SQL with a GraphQL schema). It adds a layer on top of plain SQL and ties us to Google Cloud.

## Choice

PostgreSQL hosted on Supabase, used as a plain Postgres database:

- Our server connects with `DATABASE_URL`. Use the **direct connection** if the host has IPv6; otherwise the **shared pooler in session mode** (port 5432, user `postgres.<project-ref>`), which is IPv4 on every plan and supports prepared statements. Do not use transaction mode (port 6543): it is meant for serverless and edge functions, not a long-running server like ours. Connection strings checked in Supabase docs on 2026-10-24.
- We do not use Supabase's auto-generated REST API or client SDKs for data access. All access goes through our code (`routes → services → db`), so the business rules can't be bypassed.
- Supabase Auth is the planned option for teacher authentication when the MCP server becomes remote ([decision 0007](0007-mcp-stdio-thin-client.md)). That is a separate, later decision.
- The query layer and migrations are Drizzle ORM and drizzle-kit ([decision 0013](0013-drizzle-orm-and-kit.md)).

## Why

- **Relational data.** Every key query is a join, an aggregate or a multi-table transaction. Firestore would force duplicated data and integrity checks in our code. Firebase is strong for mobile apps with real-time sync and clients reading the database directly; we have neither.
- **No server to run.** Backups, updates and hosting are managed. Self-hosting is work that doesn't teach anything this project is about.
- **Standard Postgres, low lock-in.** We connect like to any Postgres. Moving to Neon, Railway or our own server later means changing one connection string, as long as we do not depend on Supabase-only features (Data API, RLS policies, client SDKs).
- **Auth when we need it.** Supabase Auth is there for the remote MCP step without adding another provider. This is the advantage over Neon or Railway Postgres; without it, any managed Postgres would do.
- **SQLite** is fine for a spike but has a single writer and no `SKIP LOCKED`, and production would need Postgres anyway.

## Consequences

- Two Supabase projects: `dev` for development and experiments, `prod` for a real course, so test data never mixes with real data.
- The free plan pauses an inactive project (the first draft said after 7 days; not confirmed in the docs we read, check the current rule); a paused project has to be resumed in the dashboard. Move `prod` to a paid plan before a real course. Backups and point-in-time recovery are paid features (PITR is a paid add-on); confirm what the free plan keeps before trusting it with real data.
- **Exposed API surface.** Tables created in the `public` schema can be reachable through Supabase's Data API with the public `anon` key. Our server connects as the `postgres` role, which bypasses row-level security, so RLS does not protect our own access, and it does not need to. At the database task, do one of two things for every table: disable the Data API for the project, or enable RLS with no policies. Student emails and answers must not be readable with the anon key. Verify this with an unauthenticated request before real data is loaded.
- **One tenant per company.** Decided: one deployment per tenant ([decision 0012](0012-one-deployment-per-tenant.md)), so one Supabase project per tenant and no `tenant_id`. Every new customer means a new project and a new bill; script the setup before the second customer.
- **Data location.** Pick the Supabase region deliberately; company and university data may have residency rules.
- Tests that need a database run against a local Postgres (Docker or the Supabase CLI), not against `dev`. Decided at the database task.
- The first tasks (Slack spike, calculator) don't use the database; it is connected from the database task on (Roadmap Task 4 in [implementation-plan.md](../implementation-plan.md)).
- The scheduler's in-process tick and the claim query work on a plain Postgres connection; no Supabase feature is needed.

## Corrections made in review

- The draft said to use "the session pooler (port 5432)" without a condition. Supabase recommends the direct connection when IPv6 is available, so the choice is now conditional.
- Added: transaction mode ruled out, the Data API exposure risk, the tenant-per-project cost, region and backups.
- Added the link back to our data model, scheduler and requirements so the decision is traceable.
- The tenant question and the query layer were open when this was written; they are now decisions 0012 and 0013.
