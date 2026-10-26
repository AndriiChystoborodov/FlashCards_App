import { describe, expect, it } from 'vitest';
import { SPIKE_CARD, REJECT_TEXT, buildCardMessage, buildRatingMessage, buildRejectionMessage, buildWrongMessage, escapeMrkdwn } from './card.js';

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

  it('H9: a card with nine options at the REST cap (2,900 characters) stays inside Slack\'s limits', () => {
    const options = Array.from({ length: 9 }, (_, i) => `${i}`.repeat(100)); // 900 characters
    const card = { id: 'c'.repeat(36), question: 'q'.repeat(2900 - 900), options };
    const m = buildCardMessage(card);
    const section = m.blocks[0]!;
    expect(section.type === 'section' && section.text?.text.length).toBeLessThanOrEqual(3000);
    expect(m.text.length).toBeLessThanOrEqual(3000);
    const els = m.blocks.flatMap((b) => (b.type === 'actions' ? b.elements : []));
    expect(els).toHaveLength(10); // nine numbers and "Don't know"
    for (const e of els) {
      expect('text' in e && e.text && 'text' in e.text ? e.text.text.length : 0).toBeLessThanOrEqual(75);
      expect(('value' in e ? String(e.value) : '').length).toBeLessThanOrEqual(2000);
      expect(('action_id' in e ? String(e.action_id) : '').length).toBeLessThanOrEqual(255);
    }
    expect(els.map((e) => ('action_id' in e ? e.action_id : ''))).toContain('answer_9');
  });

  it('teacher text cannot trigger Slack mentions or links', () => {
    const m = buildCardMessage({ id: 'c', question: 'Who is <!channel> & <@U1>?', options: ['a>b', 'c'] });
    expect(m.text).toBe('Q: Who is &lt;!channel&gt; &amp; &lt;@U1&gt;?\n1. a&gt;b\n2. c');
    expect(escapeMrkdwn('<x>&')).toBe('&lt;x&gt;&amp;');
  });

  it('the wrong message adds the material and each refusal has its text (duplicate has none)', () => {
    expect(buildWrongMessage(SPIKE_CARD, 'https://m.test/x').text).toBe('Not quite. The right answer is 2: 500.\nMaterial: https://m.test/x');
    expect(Object.keys(REJECT_TEXT).sort()).toEqual(['course_over', 'not_enrolled', 'not_open', 'removed', 'sent_again']);
    expect(buildRejectionMessage('sent_again').text).toBe('This card was sent again, use the latest message');
    expect(buildRejectionMessage('removed').text).toBe('You are no longer enrolled in this course');
    expect(buildRejectionMessage('course_over').text).toBe('The course is over.');
    expect(buildRejectionMessage('not_open').text).toBe('This card was already answered.');
    expect(buildRejectionMessage('not_enrolled').text).toBe('You are not enrolled in this course.');
  });
});
