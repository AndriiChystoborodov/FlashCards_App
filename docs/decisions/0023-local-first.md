# 0023. Local first: Node.js and local Postgres, no cloud for now

Source: the user, on the principal engineer's review, 2026-10-25.

## Context

Decision 0010 chose PostgreSQL on Supabase. After developer's review, asked for the shortest path to a working proof of concept, without hosting or cloud setup.

## Choice

1. Development runs on Node.js and a local PostgreSQL from `docker-compose.yml`. No Supabase, no hosting, no cloud setup for now. `DATABASE_URL` in `.env` points at the local Docker Postgres.
2. Decision 0010 is superseded **in its hosting part only** (Supabase projects, pooler and Data API notes, Supabase Auth). PostgreSQL stays, and so does Drizzle with drizzle-kit ([0013](0013-drizzle-orm-and-kit.md), unchanged).
3. Hosting later: managed Postgres on Railway. Not decided in detail; it gets its own decision when it is needed.
4. Auth for now: the local teacher token in the database ([0014](0014-teacher-token-hashed.md) stays). Remote MCP and OAuth are postponed ([0007](0007-mcp-stdio-thin-client.md)).
5. Goals in this order: a working proof of concept, then a clean presentation, then maintainability. One service, split into folders (`src/domain`, `src/db`, `src/slack`, ...) so parts can be separated later.
6. Process: an end-to-end scenario script is added to the Roadmap (Task 4a, proposed; see [implementation-plan.md](../implementation-plan.md)), with an injectable clock.

## Why

A proof of concept needs no external account. Сloud setup distracts from the core (logic, data, endpoints, Slack); load balancer, scaling and hosting are hosting configuration that can be done later; for a proof of concept a local setup is enough.

## Consequences

- Hosting wording in 0010, 0012, 0013 and 0014 is kept as history and marked superseded.
- Row level security in the migration existed to close the Supabase Data API ([0022](0022-task4-schema-choices.md) point 13). Locally nothing needs it. It stays in the schema until the user decides (open question).
- Tenant isolation ([0012](0012-one-deployment-per-tenant.md)) now reads: one database and one deployment per tenant; where it is hosted is open.
