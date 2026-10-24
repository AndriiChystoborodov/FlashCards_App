# 0014. Teacher API token stored hashed in the database

## Context

The REST API needs to know which teacher calls it. The MCP server uses a bearer token from the environment ([decision 0007](0007-mcp-stdio-thin-client.md)). Supabase Auth is the later option for a remote server.

## Options

- One static token in env, shared.
- A random token per teacher, stored hashed in `users.api_token_hash`.
- Supabase Auth now.

## Choice

A random token per teacher, stored hashed in `users.api_token_hash`. Chosen by the user on 2026-10-24.

## Why

It maps a request to a `teacher_id` without an auth provider, and a database leak does not reveal usable tokens. It is a small piece: one column and one middleware, both replaced when Supabase Auth arrives.

## Details

- The token is 32 random bytes, shown once when issued by a script (no endpoint to read it back). Only its SHA-256 hash is stored. A fast hash is enough because the token has high entropy.
- Unique index on `api_token_hash`. The middleware hashes the bearer value and looks up the teacher; a miss is 401.
- Reissuing overwrites the hash, which revokes the old token. One active token per teacher.
- Never log the header or the token.
- Students have no REST token; they act through Slack.
