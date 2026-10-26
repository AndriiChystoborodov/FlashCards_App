import type { types } from '@slack/bolt';
import type { Rating3 } from '../domain/calculator.js';
import type { RejectReason } from '../services/answer.js';

type KnownBlock = types.KnownBlock;

export type Rating = Rating3;

export interface SpikeCard {
  id: string;
  question: string;
  options: string[];
  /** 0-based index. Lives only on the server, never in a button value. */
  correctOption: number;
}

export interface CardMessage {
  text: string;
  blocks: KnownBlock[];
}

export const SPIKE_CARD: SpikeCard = {
  id: 'spike-1',
  question: 'What is the maximum fine under the policy?',
  options: ['100', '500', '1000'],
  correctOption: 1,
};

export const ALREADY_ANSWERED_TEXT = 'This card was already answered.';

/** What a refused click shows (docs/slack/integration.md; `not_open` and `not_enrolled` were chosen in Task 8). `duplicate` has none: nothing is shown. */
export const REJECT_TEXT: Record<RejectReason, string> = {
  sent_again: 'This card was sent again, use the latest message',
  removed: 'You are no longer enrolled in this course',
  course_over: 'The course is over.',
  not_open: ALREADY_ANSWERED_TEXT,
  not_enrolled: 'You are not enrolled in this course.',
};

export const ERROR_TEXT = 'Something went wrong. Please try again.';

/** Slack mrkdwn treats `&`, `<` and `>` as control characters (mentions, links); teacher text must not trigger them. */
export const escapeMrkdwn = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const RATING_LABELS: Record<Rating, string> = { hard: 'Hard', medium: 'Medium', easy: 'Easy' };

export const textOnly = (text: string): CardMessage => ({
  text,
  blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
});

const button = (actionId: string, label: string, value: string) => ({
  type: 'button' as const,
  action_id: actionId,
  text: { type: 'plain_text' as const, text: label },
  value,
});

/** Only what the card message needs: never the correct option (H2). */
export type CardView = Pick<SpikeCard, 'id' | 'question' | 'options'>;

export function buildCardMessage(card: CardView): CardMessage {
  const question = escapeMrkdwn(card.question);
  const list = card.options.map((o, i) => `${i + 1}. ${escapeMrkdwn(o)}`).join('\n');
  const buttons = card.options.map((_, i) =>
    button(`answer_${i + 1}`, String(i + 1), JSON.stringify({ c: card.id, o: i })),
  );
  buttons.push(button('answer_dont_know', "Don't know", JSON.stringify({ c: card.id, o: null })));
  return {
    text: `Q: ${question}\n${list}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${question}*\n${list}` } },
      { type: 'actions', elements: buttons },
    ],
  };
}

export function buildRatingMessage(card: Pick<SpikeCard, 'id'>, chosenOption: number): CardMessage {
  const text = 'Right. How hard was it?';
  const buttons = (Object.keys(RATING_LABELS) as Rating[]).map((r) =>
    button(`rate_${r}`, RATING_LABELS[r], JSON.stringify({ c: card.id, o: chosenOption, r })),
  );
  return {
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, { type: 'actions', elements: buttons }],
  };
}

export const buildRatedMessage = (rating: Rating): CardMessage =>
  textOnly(`Thanks. You rated it ${RATING_LABELS[rating]}.`);

export const buildWrongMessage = (card: Pick<SpikeCard, 'options' | 'correctOption'>, materialUrl?: string): CardMessage =>
  textOnly(
    `Not quite. The right answer is ${card.correctOption + 1}: ${escapeMrkdwn(card.options[card.correctOption]!)}.` +
      (materialUrl ? `\nMaterial: ${escapeMrkdwn(materialUrl)}` : ''),
  );

export const buildRejectionMessage = (reason: RejectReason): CardMessage => textOnly(REJECT_TEXT[reason]);

export const buildAlreadyAnsweredMessage = (): CardMessage => textOnly(ALREADY_ANSWERED_TEXT);
