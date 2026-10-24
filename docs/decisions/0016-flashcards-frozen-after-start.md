# 0016. Flashcards are frozen once the course has started

## Context

Teachers edit cards through the REST API and MCP. A student's `card_states`, `reviews` and assessment result depend on the cards as they were when sent. The first draft allowed edits until "any student has the card", which depends on timing and is hard to explain to a teacher or an agent.

## Options

- Free edits at any time. A changed question or `correct_option` invalidates stored reviews and FSRS state; an assessment flag change after the assessment ran makes scores wrong.
- Immutable once any `card_states` row exists for the card.
- Editing and deleting only while the course is `draft`; after `start`, only adding new cards.

## Choice

The third option. Chosen by the user on 2026-10-24.

| Course status | `POST` flashcards | `PATCH` flashcard (incl. `is_assessment`, `position`) | `DELETE` flashcard |
| --- | --- | --- | --- |
| `draft` | allowed | allowed | allowed |
| `active` | allowed | 409 `course_not_draft` | 409 `course_not_draft` |
| `finished` | 409 `course_finished` | 409 `course_not_draft` | 409 `course_not_draft` |

- Marking or unmarking a card as assessment is an edit, so it follows the same rule.
- A card added to an `active` course joins the pool and is introduced by the daily N ([decision 0006](0006-new-cards-per-day.md)). It must have `is_assessment: false`: the assessment has already run for enrolled students, so a new assessment card gets 400 `assessment_closed`. Its `position` goes to the end.
- Students already `completed` do not get new cards ([decision 0011](0011-enrollment-completed.md)).

## Why

The rule depends only on the course status, which the teacher and an agent can see, not on whether some student happens to have received the card. It keeps reviews, scores and FSRS state tied to the card that was actually asked, and it removes the case of editing a card students are already answering.

## Consequences

- A typo found after the start cannot be fixed. The teacher can add a corrected card, but the wrong one stays. If that proves too limiting, a future decision can allow editing `question` and `material_url` only (not options, `correct_option` or the assessment flag).
- The MCP tool descriptions for `update_flashcard` and `delete_flashcard` say "draft courses only", so the agent does not try them on a running course. `add_flashcards` says new cards after the start cannot be assessment cards.
- [data-model.md](../data-model.md#flashcards) states the same rule on the table.
