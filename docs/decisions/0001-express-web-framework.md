# 0001. Express as the web framework

## Context

The REST API (teacher/MCP side) and the Slack integration need a web server. The team is one person. The MVP has database and a load of about 1,000 students in one class.

## Options

- **Express.** Minimal, well known to the author. Slack Bolt supports it out of the box through its Express receiver.
- **NestJS.** Gives a fixed structure (modules, controllers, services) and dependency injection. But every endpoint needs extra boilerplate, which does not pay off for a small MVP, and its concepts (DI, decorators, guards, pipes) are new to the author. We already get the structure from our `routes → services → db` convention.
- **Fastify.** Faster and typed, but the author does not know it and Bolt integration needs more glue.

## Choice

Express.

## Why

- It is simple and the author already knows it.
- Bolt works with it without adapters, so one server can serve both the API and Slack.
- The expected load does not need a faster framework.

## Not now

- No Redis (no queue or cache need yet).

Revisit when load, background jobs or abuse protection become real requirements.
