# 0008. Delivery: next card only after an answer

## Context

A student can have many due cards. Options are to send them all at once or one by one.

## Options

- One DM per due card, all at once.
- One open card at a time; the next is sent when the previous is answered.

## Choice

One open card at a time. Chosen by the user on 2026-10-24.

## Why

Less spam, simpler idempotency (at most one `sent_at` per student), and a smoother load on Slack. The tick only starts the day. Unanswered cards are re-sent as a reminder every `REMINDER_AFTER_HOURS` (default 24) up to `MAX_REMINDERS` (default 2) times, never as a new card; after that the card stays open until answered or the course ends. See [scheduler.md](../scheduler.md#unanswered-cards).
