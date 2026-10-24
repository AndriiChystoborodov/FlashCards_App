# 0013. Query layer and migrations: Drizzle ORM with drizzle-kit

## Context

[Decision 0010](0010-database-postgres-supabase.md) chose PostgreSQL on Supabase and left the query layer and the migration tool open. The code follows `routes → services → db` in strict TypeScript with no `any`. `CardState` maps one to one onto `card_states` ([fsrs-calculator.md](../fsrs-calculator.md)).

## Options

- Drizzle ORM with drizzle-kit for migrations.
- Kysely, with a separate migration tool.
- Plain `pg` with hand-written SQL and migration files.

## Choice

Drizzle ORM (`drizzle-orm`) with drizzle-kit for migrations. Chosen by the user on 2026-10-24.

## Why

- The schema is written once in TypeScript (`src/db/schema.ts`) and the row types come from it, so a column change shows up as a type error. That fits the "schema follows the calculator" rule.
- drizzle-kit generates plain SQL migration files that are committed and reviewed.
- Composite primary keys, `timestamptz`, `jsonb` and transactions are supported. SQL stays close to the surface, so the claim query and aggregates remain readable; raw `sql` is available where the builder gets in the way.

## Consequences

- Repositories in `src/db/` map `last_review` (`undefined` in ts-fsrs, null in the database) and `state` (smallint) at the boundary.
- Migrations run over the direct connection or the session pooler, not transaction mode ([decision 0010](0010-database-postgres-supabase.md)).
- To verify at the database task: `FOR UPDATE SKIP LOCKED` in the Drizzle select API (otherwise use `sql`), and how RLS is enabled on tables for the Data API closure from decision 0010.
- Tests that need the database run against a local Postgres with the same migrations.
- Pin versions of `drizzle-orm` and `drizzle-kit` together; they are released as a pair.
