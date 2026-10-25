# 0009. Calculator takes the FSRS scheduler as a default parameter

## Context

`applyAnswer` needs an FSRS instance. Tests need `enable_fuzz: false`; production may want fuzz. The Problem is. For testing, we need a scheduler without fuzz; otherwise, each run will produce different dates, and the test cannot be verified. But in production, fuzz might be necessary. This means the calculator must be able to work with different schedulers.

## Options

- `scheduler: FSRS = defaultScheduler` as the last parameter.
- Build a scheduler from a config object on every call.

## Choice

Default parameter. Chosen by the user on 2026-10-24.

## Why

`next()` has no side effects, so one module-level instance is enough. The function stays pure and deterministic, and callers never think about it. `scheduler` is the last parameter. The `due` clamp from [decision 0015](0015-learned-needs-retention-gap.md) is not a parameter; the answer service applies it after the call.

`CardState = Card & { correctStreak; learnedAt }` uses ts-fsrs's own `Card` type, so a ts-fsrs upgrade shows up as a type error.
