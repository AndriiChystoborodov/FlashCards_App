import { describe, expect, it } from 'vitest';
import { SPIKE_CARD, buildCardMessage, buildRatingMessage, buildWrongMessage } from './card.js';

describe('card message', () => {
  const msg = buildCardMessage(SPIKE_CARD);
  const buttons = msg.blocks.flatMap((b) => (b.type === 'actions' ? b.elements : []));

  it('puts question and numbered options in the text, with buttons 1, 2, 3, Don\'t know', () => {
    expect(msg.text).toBe('Q: What is the maximum fine under the policy?\n1. 100\n2. 500\n3. 1000');
    expect(buttons.map((b) => ('text' in b && b.text && 'text' in b.text ? b.text.text : ''))).toEqual(['1', '2', '3', "Don't know"]);
    expect(buttons.map((b) => ('action_id' in b ? b.action_id : ''))).toEqual([
      'answer_1', 'answer_2', 'answer_3', 'answer_dont_know',
    ]);
  });

  it('H2: no button value reveals the correct answer, only card id and chosen option', () => {
    const values = buttons.map((b) => ('value' in b ? b.value : undefined));
    expect(values).toEqual([
      '{"c":"spike-1","o":0}', '{"c":"spike-1","o":1}', '{"c":"spike-1","o":2}', '{"c":"spike-1","o":null}',
    ]);
    expect(JSON.stringify(msg)).not.toContain('correct');
  });

  it('rating buttons carry card id, option and rating', () => {
    const r = buildRatingMessage(SPIKE_CARD, 1);
    expect(r.text).toBe('Right. How hard was it?');
    expect(JSON.stringify(r.blocks)).toContain('{\\"c\\":\\"spike-1\\",\\"o\\":1,\\"r\\":\\"easy\\"}');
  });

  it('wrong message shows the right answer', () => {
    expect(buildWrongMessage(SPIKE_CARD).text).toBe('Not quite. The right answer is 2: 500.');
  });
});
