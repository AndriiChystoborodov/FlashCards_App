# 0007. MCP server: separate stdio process, thin REST client

## Context

Teachers use an MCP client (Claude, Codex). Architecture says AI first = API first.

## Options

- Separate stdio process calling the REST API with an env token.
- Streamable HTTP inside the API process with OAuth.
- Old SDK 1.x (`@modelcontextprotocol/sdk`).

## Choice

First option, on SDK v2 (`@modelcontextprotocol/server`, needs zod 4). Chosen by the user on 2026-10-24.

## Why

Keeps `routes → services → db` as the only way into business logic. Over stdio the spec says credentials come from env, so no OAuth server now. A crash cannot take down the Slack bot. The tool definitions move to HTTP later without change. The REST API needs a teacher token middleware (see [mcp-teacher-api.md](../mcp-teacher-api.md)). Task 1 installs zod 4.

## Target and first step

stdio is the first step for the MVP, where the only teacher is the author. The target is a remote MCP server over Streamable HTTP with real teacher auth (Supabase Auth was planned). Moving there is a later decision and gets its own file; this one does not pick the auth provider.

To keep that move cheap, tool definitions (name, description, zod input schema, REST mapping) live in one transport-independent module, for example `src/mcp/tools.ts`, which exports a function that registers them on an `McpServer`. Only a small entry file knows the transport: `serveStdio` today, `createMcpHandler` with `requireBearerAuth` later. Tool handlers call the REST API through an injected client, so the base URL and the credential come from the entry point, not from the tools. Switching transports then changes the entry file and the auth middleware, not the tools.
