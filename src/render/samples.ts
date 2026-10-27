/** Fixed inputs for the renderer tests, `npm run render:samples` and the Slack image spike. */
export const SAMPLES = {
  short: 'What is the maximum fine under the policy?',
  // 498 characters: close to the 500 limit.
  long:
    'Under the company data retention policy, which of the following statements describes how long customer invoices must be kept, who may authorise their early deletion, and what has to be recorded in the audit log when the deletion happens? Consider the cases of paper invoices, scanned copies and invoices stored in the accounting system, and remember that the answer differs for invoices that are part of an open dispute with the customer or with the tax authority.',
  russian: 'Какой максимальный штраф предусмотрен политикой компании за повторное нарушение правил информационной безопасности?',
  ukrainian: 'Який відсоток працівників має пройти навчання, щоб їжак, єнот і ґанок на логотипі компанії лишилися в інструкції?',
  umlauts: 'Welche Überstunden müssen laut Betriebsvereinbarung für Außendienstmitarbeiter vergütet werden: Äpfel, Öl, Müller, Größe?',
} as const;

/** Must be refused with `unsupported_character` (emoji, Arabic, Chinese). */
export const UNSUPPORTED = ['Is this fine 😀 ?', 'مرحبا what is this', '漢字 means what?'] as const;

export const TOO_LONG = 'x '.repeat(251); // 502 characters

/** Invisible and control characters around real text: sanitized away, the text stays. */
export const INVISIBLE_MIX = 'Zero\u200Bwidth \u202Ebidi\u202C and\u0007 control\u0000 chars\uFEFF  and   spaces\tcollapse\r\n\r\n\r\n\r\nend';
