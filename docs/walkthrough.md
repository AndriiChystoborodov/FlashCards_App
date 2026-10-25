# Example flashcard and a full use case

FSRS numbers come from running ts-fsrs 5.4.2 with `learning_steps` and `relearning_steps` `['1d']`, `enable_fuzz: false` (see [fsrs-calculator.md](fsrs-calculator.md)). The course, names and dates are made up. Cards are answered at different times of day; the scheduler compares `due` with the end of the student's local day ([scheduler.md](scheduler.md#selecting-the-next-card)), so the daily 09:00 tick sends everything due that day.

## The card

```json
{
  "id": "card-1",
  "question": "How soon must a security incident be reported?",
  "options": ["Within 1 hour", "Within 24 hours", "Within 7 days"],
  "correct_option": 0,
  "is_assessment": false,
  "material_url": "https://wiki.example.com/security-policy#incidents",
  "position": 1
}
```

Course "Security basics": 10 cards, 3 of them assessment, `assessment_pass_threshold` 90. The teacher picks no daily limit: the scheduler computes it ([decision 0006](decisions/0006-new-cards-per-day.md)). The course ends Friday of the following week. Student Ann, teacher Tom.

## 1. Teacher sets up (through MCP)

| step | tool | effect |
| --- | --- | --- |
| 1 | `create_course` | draft course |
| 2 | `add_flashcards` | 10 cards, 3 with `is_assessment: true` |
| 3 | `enroll_students` ann@x.com | user created, `users.lookupByEmail` fills `slack_id`; enrollment `active` |
| 4 | `start_course` (after Tom confirms, Monday 10:00) | course `active`; Ann gets a DM and the first assessment card at once |

## 2. Assessment (Monday)

Ann receives the three assessment cards, one after another (decision 0008), and answers all three around 14:00. The three assessment cards are different cards from `card-1` above (ids `card-a1` to `card-a3`). The first, A1, has its own question. Its message:

```
Who must approve a purchase above 5,000?
1. The department head
2. Any manager
3. The purchasing clerk
[1] [2] [3] [Don't know]
```

A1's `correct_option` is 0 ("The department head").

Ann clicks `1`. The handler acks, parses `{"c":"card-a1","o":0}`, sees the answer is right (the server knows; the button never did), and replaces the message with "Right. How hard was it?" and `[Hard] [Medium] [Easy]`. She clicks Easy: `{"c":"card-a1","o":0,"r":"easy"}`. `applyAnswer` runs; a review row is stored; the message is replaced with the outcome.

Her three assessment results:

| card | answer | rating | passed |
| --- | --- | --- | --- |
| A1 | right | easy | yes |
| A2 | right | medium | no |
| A3 | Don't know | none | no |

After A3 (about 14:05), `evaluateAssessment` runs once: score 1/3 = 33% < 90%, so Ann is not exempt. A1 gets `learned_at = Monday`. A2 and A3 continue as normal FSRS cards. `assessment_done_at` is set. Status stays `active`. Had she passed 90% or more, she would be `exempt`, at 100%, with a DM saying she already knows the material.

## 3. Normal mode (Tuesday onward)

Right after the assessment, on Monday at about 14:05, the answer handler calls `next()`: nothing is due today, so it introduces new non-assessment cards by `position`, one at a time, starting with `card-1`. Quota for Monday: 7 non-assessment cards remain and 12 local days are left (Monday to the Friday of the next week, inclusive, weekends counted), so `ceil(7 / 12)` = 1 card. Ann gets only `card-1`.

**card-1, Monday 14:06:** right, Medium. FSRS grade Good. `scheduled_days` 2 (stability 2.31, difficulty 2.12), `correct_streak` 1, `due` Wednesday 14:06.

**Tuesday 09:00 tick:** A3 ("Don't know", Again, `due` Tuesday 14:05) is sent at the 09:00 tick because `due` is before the end of Tuesday. With `due <= now` it would have waited until Wednesday. Ann answers A3 right and Medium: FSRS grade Good after a first Again gives `scheduled_days` 2 (stability 1.89, difficulty 6.40), streak 1, `due` Thursday.

**Wednesday 09:00 tick:** card-1 (`due` Wednesday 14:06) and A2 are both due today. A2 (`due` 14:03) comes first, then card-1 (`due` 14:06): the order is by `due`.

**card-1, Wednesday 09:15:** right, Medium again. Grade Good, `scheduled_days` 11 (stability 10.96, difficulty 2.11), `correct_streak` 2. The gap since the previous review (Monday 14:06) is about 1.8 days, less than `MIN_RETENTION_DAYS` (7), so the card is **not learned** ([decision 0015](decisions/0015-learned-needs-retention-gap.md)). FSRS `due` would be Sunday 18 January 09:15, but the course ends on Friday 16 January, so `due` is clamped to the end of Thursday 15 January, the day before `ends_at`.

**card-1, Thursday 15 January, 09:20:** right, Medium. Gap since Wednesday 09:15 is 8.0 days, at least 7. `correct_streak` 3 (at least 2), so `learned_at` = Thursday 15 January. The card is never sent again. Without the clamp, FSRS would have scheduled it after the course and this last review would not have happened.

**Other paths for another card:**

| answers | scheduled_days | correct_streak | learned |
| --- | --- | --- | --- |
| Easy, Easy (second answer 8 days later) | 8, 66 | 1, 2 | on 2nd answer, gap 8 days |
| Hard, Hard, Good | 1, 4, 12 | 0, 0, 1 | no |
| Good, Again | 2, 1 | 1, 0 | no |

The assessment cards: A2 (right + Medium on Monday, about 14:03) is due in 2 days (Wednesday) with streak 1. A3 ("Don't know", about 14:05) is due the next day (Tuesday) with streak 0, stability 0.21, difficulty 6.41.

## 4. Progress

> **Not reachable in this course.** The "10 / 10" path below cannot happen here under the current rules. The course is 12 days long, new cards are spread over the whole course, and a card needs a 7-day gap between its last two reviews. Cards introduced in the second half cannot be learned before `ends_at`, so even a perfect Medium student ends below 100% (the user's estimate: about 5 of 10 learned). The real outcome is `completed` at `ends_at` with `completed_progress` well under 100. The 10 / 10 sentence stays only to show the mechanism. See the open question in [scheduler.md](scheduler.md#selecting-the-next-card).

After Ann has learned A1, card-1 and 2 more cards: progress = 4 / 10 = 40%. Tom's `get_class_progress` returns Ann at 40 and the class average over all enrolled students. At 10 / 10 her enrollment becomes `completed` with `completed_progress` 100 and she gets a DM. If the course reached `ends_at` with 6 of 10 learned, she would become `completed` with `completed_progress` 60.

## 5. Stop

Tom calls `stop_course`: course `finished`, DM to students, no more cards.

## 6. Edge cases to remember

- Ann double-clicks `1`: the second insert hits the unique `(user_id, flashcard_id, delivery_sent_at)` key and is ignored. She still sees the replaced message.
- Ann ignores a card: after 24 hours the same card is re-posted as a reminder (the old message says "Sent again below"); after 24 more hours a second reminder; then nothing more is sent and the card stays open. No new card is sent until she answers.
- Tom adds a card mid-course: it joins the pool and is introduced by position.
- Ann has no Slack match: `slack_matched: false` in Tom's student list; she gets nothing until the email matches.
