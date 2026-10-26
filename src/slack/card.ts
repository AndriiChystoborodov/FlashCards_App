import type { types } from '@slack/bolt';

type KnownBlock = types.KnownBlock;

export type Rating = 'hard' | 'medium' | 'easy';

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

export function buildCardMessage(card: SpikeCard): CardMessage {
  const list = card.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  const buttons = card.options.map((_, i) =>
    button(`answer_${i + 1}`, String(i + 1), JSON.stringify({ c: card.id, o: i })),
  );
  buttons.push(button('answer_dont_know', "Don't know", JSON.stringify({ c: card.id, o: null })));
  return {
    text: `Q: ${card.question}\n${list}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${card.question}*\n${list}` } },
      { type: 'actions', elements: buttons },
    ],
  };
}

export function buildRatingMessage(card: SpikeCard, chosenOption: number): CardMessage {
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

export const buildWrongMessage = (card: SpikeCard): CardMessage =>
  textOnly(`Not quite. The right answer is ${card.correctOption + 1}: ${card.options[card.correctOption]}.`);

export const buildAlreadyAnsweredMessage = (): CardMessage => textOnly(ALREADY_ANSWERED_TEXT);
