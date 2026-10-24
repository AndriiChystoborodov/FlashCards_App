# 0005. Assessment pass: right and Easy only

## Context

AGENTS.md and requirements.md say an assessment answer passes only if right and rated Easy. The design phase raised whether Medium should also pass.

## Options

- Right + Easy only.
- Right + Medium or Easy.

## Choice

Right + Easy only. Chosen by the user on 2026-10-24. The 90% default threshold may still change (`courses.assessment_pass_threshold`).

## Why

Exemption removes all cards, so it must mean real mastery. A student who found a card "medium" still gets the repetition. Note the different rule for ordinary learning: a card is learned after 2 right answers in a row rated Medium or Easy.
