# 0012. One deployment per tenant

## Context

Requirements say "one tenant per company or university". The data model needs to know whether tables carry a tenant id.

## Options

- One shared deployment and database, a `tenant_id` on every table and in every query.
- One deployment per tenant: its own process, its own database, its own Slack app and environment.

## Choice

One deployment per tenant. No `tenant_id` anywhere. Chosen by the user on 2026-10-24.

## Why

It isolates customers completely (data, Slack workspace, tokens) and removes a class of bugs: no query can forget a tenant filter. The MVP has one tenant anyway. Each tenant has one Slack workspace, so one Slack app per deployment fits.

## Consequences

- Each tenant gets its own Supabase project ([decision 0010](0010-database-postgres-supabase.md)), `.env` and Slack app tokens. A new customer means a new project and a new bill; deployment and migrations must be scripted before the second customer.
- Timezone and similar settings are per deployment (`TENANT_TIMEZONE`).
- Cross-tenant reporting is not possible and is not needed.
- If a shared multi-tenant service is ever wanted, adding `tenant_id` is a large migration and a new decision.
