# 0036. start_course: the user's request to start is the confirmation

Source: the user, 2026-10-31. In a real Claude session the teacher reviewed and approved the draft cards, said "Start the course", and the agent still listed all cards again and asked "Do you confirm I should start it now?". The user does not want a second approval after an explicit request to start.

## Context

Decision 0031 made the `start_course` description order three steps before the call: list the cards, show them with the correct options, ask for confirmation. The teacher's own client already asks to approve tool calls, and the teacher had just said "start the course".

## Choice

- The `start_course` description now says: if the user has asked to start this course, that request IS the confirmation; call at once with `confirmed: true`; do not list the cards again and do not ask for a second approval. Only when the agent itself proposes starting does it first say what starting does and wait for a yes.
- Unchanged: the input schema still requires `confirmed: true` (a call without it is refused with no HTTP call), the description still says in capitals that the tool messages students and cannot be undone, and the freeze rules are still listed. `stop_course`, `delete_course` and `remove_student` are unchanged.
- The `confirmed` field text now says it is true because the user explicitly asked to start.

## Why

The step added friction without adding information: the cards were reviewed before the course was created, and an explicit "start the course" is the teacher's decision. The `confirmed` flag stays so that a call the model makes on its own initiative, without the flag, still fails.

## Limits

- The description is guidance for the model, not a security gate. A model that starts a course the user did not ask for is not stopped by the schema.
- A client sees the new description only after its MCP server is restarted (restart Claude Code or Claude Desktop, or re-run `claude mcp` for the server).
- Supersedes the `start_course` ordering in decision 0031.
