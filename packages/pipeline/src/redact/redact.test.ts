import { describe, expect, it } from 'vitest';
import { generate } from '../seed/generate.ts';
import { redact } from './redact.ts';

const r = (s: string) => redact(s).text as string;

describe('redact: EMAIL', () => {
  it.each([
    ['my email is maria.garcia@example.com.', 'my email is [EMAIL].'],
    ['Contact JOHN_doe+billing@mail.co.uk now', 'Contact [EMAIL] now'],
    ['a@b.io and c.d@e-f.org', '[EMAIL] and [EMAIL]'],
  ])('%s', (input, expected) => expect(r(input)).toBe(expected));
});

describe('redact: PHONE', () => {
  it.each([
    ['call (415) 555-0123', 'call [PHONE]'],
    ['call 415-555-0123 or 415.555.0123', 'call [PHONE] or [PHONE]'],
    ['call +1 415 555 0123', 'call [PHONE]'],
    ['call 4155550123.', 'call [PHONE].'],
  ])('%s', (input, expected) => expect(r(input)).toBe(expected));
});

describe('redact: ACCOUNT (account and card digit runs)', () => {
  it.each([
    ["It's 48217730.", "It's [ACCOUNT]."],
    ['ACCT-48217730', '[ACCOUNT]'],
    ['account #48217730', 'account [ACCOUNT]'],
    ['4821-7730', '[ACCOUNT]'],
    ['4 8 2 1 7 7 3 0', '[ACCOUNT]'],
    ['card ending in 4242', 'card ending in [ACCOUNT]'],
    ['4111 1111 1111 1111', '[ACCOUNT]'],
    ['ref REF-887555', 'ref [ACCOUNT]'],
  ])('%s', (input, expected) => expect(r(input)).toBe(expected));

  it('leaves money, short numbers and codes alone', () => {
    const s = 'It costs $1,299.00, or $15, in 3 to 5 days. Error E-147 at 400 Mbps.';
    expect(r(s)).toBe(s);
  });
});

describe('redact: ADDRESS', () => {
  it.each([
    ['at 7731 Chestnut St, Georgetown, TX 78661.', 'at [ADDRESS].'],
    ['moving to 12 Lakeview Dr next week', 'moving to [ADDRESS] next week'],
    ['1600 N Main Street Apt 4B, Salem, MA 01970', '[ADDRESS]'],
    ['42 Wallaby Way, Sydney', '[ADDRESS]'],
    ['send it to PO Box 1234', 'send it to [ADDRESS]'],
  ])('%s', (input, expected) => expect(r(input)).toBe(expected));
});

describe('redact: NAME', () => {
  it.each([
    // Known first names (+ following surname)
    ['Maria Garcia, maria@example.com', '[NAME], [EMAIL]'],
    ['I spoke with Priya yesterday.', 'I spoke with [NAME] yesterday.'],
    // Unknown names caught by context
    ['My name is Zephyrine Quolltrop and I need help.', 'My name is [NAME] and I need help.'],
    ['Hi Xandor, thanks for waiting.', 'Hi [NAME], thanks for waiting.'],
    ['this is Thembeka from billing', 'this is [NAME] from billing'],
    ['Hello, Brisa here.', 'Hello, [NAME] here.'],
    ['my partner, Oluwaseun Adebayo-Clarke, needs access', 'my partner, [NAME], needs access'],
    ['I talked to Ms Abernathy.', 'I talked to [NAME].'],
    ['Customer: Xandor Velloway, [EMAIL]', 'Customer: [NAME], [EMAIL]'],
    // Known surname on its own
    ['Is Okafor on the account?', 'Is [NAME] on the account?'],
    ["Maria's account", "[NAME]'s account"],
  ])('%s', (input, expected) => expect(r(input)).toBe(expected));

  it('redacts names that are also words when they are used as names', () => {
    expect(r('Hi Bill, thanks.')).toBe('Hi [NAME], thanks.');
    expect(r('I spoke to Grace Kim.')).toBe('I spoke to [NAME].');
  });

  it('keeps those words when they plainly start a sentence', () => {
    expect(r('Bill is too high this month.')).toBe('Bill is too high this month.');
    expect(r('May I ask why?')).toBe('May I ask why?');
    expect(r('Price went up.')).toBe('Price went up.');
  });

  it('does not touch ordinary capitalized words or speaker labels', () => {
    const s =
      "Customer: Thanks for reaching out.\nAgent: Hi there! I'm the virtual assistant. Is the Wi-Fi light on?";
    expect(r(s)).toBe(s);
  });

  it('never redacts across transcript lines', () => {
    expect(r('Customer: My name is\nAgent: Okay')).toBe('Customer: My name is\nAgent: Okay');
  });
});

describe('redact: behavior', () => {
  it('is idempotent', () => {
    const once = r('Hi Dana, I am Maria Garcia, (415) 555-0123, ACCT-48217730, 12 Oak St.');
    expect(r(once)).toBe(once);
  });

  it('counts tokens per type, not values', () => {
    const { counts } = redact('Maria Garcia, a@example.com, b@example.com, (415) 555-0123');
    expect(counts).toEqual({ EMAIL: 2, PHONE: 1, ACCOUNT: 0, ADDRESS: 0, NAME: 1 });
  });
});

describe('redact: every seeded transcript', () => {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  it('leaves no planted PII value in any transcript', () => {
    const data = generate();
    const raw = new Map(data.interactions.map((i) => [i.id, i.transcript]));
    const leaks: string[] = [];
    let checked = 0;
    for (const label of data.groundTruth.labels) {
      const redacted = r(raw.get(label.interactionId)!);
      for (const { type, value } of label.pii) {
        checked++;
        // Whole-value match, so "Sam" doesn't false-alarm on "Same".
        const re = new RegExp(`(?<![A-Za-z0-9])${escape(value)}(?![A-Za-z0-9])`);
        if (re.test(redacted)) leaks.push(`${label.interactionId}: ${type}`); // type only, never the value
      }
    }
    expect(checked).toBeGreaterThan(5000);
    expect(leaks).toEqual([]);
  });
});
