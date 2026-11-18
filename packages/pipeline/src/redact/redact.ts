import { AMBIGUOUS_FIRST_NAMES, FIRST_NAMES, SURNAMES } from './names.ts';

/**
 * PII redaction. Runs before scoring; the redacted text is the only version that may
 * leave the process. Over-redaction is acceptable, under-redaction is not.
 */

export const REDACTOR_VERSION = '1';

export const PII_KINDS = ['EMAIL', 'PHONE', 'ACCOUNT', 'ADDRESS', 'NAME'] as const;
export type PiiKind = (typeof PII_KINDS)[number];
export type RedactionCounts = Record<PiiKind, number>;

declare const redactedBrand: unique symbol;
/** A transcript that has been through `redact()`. Only `redact()` creates one. */
export type RedactedTranscript = string & { readonly [redactedBrand]: true };

export interface RedactionResult {
  text: RedactedTranscript;
  counts: RedactionCounts;
}

const token = (k: PiiKind) => `[${k}]`;

// Horizontal whitespace only, so patterns never run across transcript lines.
const SP = '[ \\t]';
// A capitalized word: "Maria", "O'Neil", "Anne-Marie".
const CAP = "[A-Z][a-z]+(?:['’-][A-Za-z]+)?";

// ───────────── structured PII ─────────────

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const STREET_SUFFIX =
  '(?:St|Street|Ave|Avenue|Rd|Road|Ln|Lane|Dr|Drive|Blvd|Boulevard|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Hwy|Highway|Sq|Square|Trl|Trail|Loop|Row)';
const ADDRESS = new RegExp(
  [
    `\\b\\d{1,6}${SP}+`, // house number
    `(?:(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West)\\.?${SP}+)?`,
    `(?:${CAP}${SP}+){1,4}${STREET_SUFFIX}\\b\\.?`, // street name + suffix
    `(?:${SP}*,?${SP}*(?:Apt|Apartment|Unit|Suite|Ste|#)\\.?${SP}*[A-Za-z0-9-]+)?`,
    `(?:${SP}*,${SP}*${CAP}(?:${SP}+${CAP}){0,2})?`, // city
    `(?:${SP}*,?${SP}*[A-Z]{2})?`, // state
    `(?:${SP}+\\d{5}(?:-\\d{4})?)?`, // ZIP
  ].join(''),
  'g',
);
const PO_BOX = /\bP\.?\s?O\.?\s?Box\s+\d+/gi;

// (415) 555-0123, 415-555-0123, 415.555.0123, +1 415 555 0123, 4155550123
const PHONE = /(?<![\w])(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-]?)\d{3}[ .-]?\d{4}(?![\w])/g;

// Account / card / reference numbers: any run of 4+ digits (spaces or dashes allowed between
// digits), with an optional prefix like "ACCT-", "REF-" or "#". Money amounts are left alone.
const ACCOUNT = /(?<![\w$.,])(?:[A-Za-z]{2,6}-|#)?\d(?:[ -]?\d){3,}(?![\w]|[.,]\d)/g;

// ───────────── names ─────────────

const NAME_CUES = [
  'my name is',
  "my name's",
  'name is',
  'this is',
  "i'm",
  'i am',
  'hi',
  'hello',
  'hey',
  'dear',
  'thanks',
  'thank you',
  'bye',
  'goodbye',
  'good morning',
  'good afternoon',
  'good evening',
  'speak to',
  'speak with',
  'talk to',
  'talk with',
  'ask for',
  'transfer to',
  'transferred to',
  'partner',
  'wife',
  'husband',
  'spouse',
  'son',
  'daughter',
  'mother',
  'father',
  'mom',
  'dad',
  'sister',
  'brother',
  'friend',
  'roommate',
  'colleague',
  'manager',
  'supervisor',
  'tenant',
  'landlord',
  'account holder is',
  'name on the account is',
  'signed',
  'regards',
].map(caseInsensitive);

/** "hi there" → "[Hh][Ii][ \t]+[Tt]…", so only the cue ignores case, not the name after it. */
function caseInsensitive(phrase: string): string {
  return [...phrase]
    .map((ch) => {
      if (ch === ' ') return `${SP}+`;
      if (ch === "'") return "['’]";
      const lo = ch.toLowerCase();
      const up = ch.toUpperCase();
      return lo === up ? ch : `[${up}${lo}]`;
    })
    .join('');
}

/** Capitalized word(s) right after a cue: "my name is Zed Quill", "Hi Dana", "partner, Ann". */
const AFTER_CUE = new RegExp(
  `(\\b(?:${NAME_CUES.join('|')})${SP}*,?${SP}*)(${CAP}(?:${SP}+${CAP}){0,2})`,
  'g',
);
const TITLE = new RegExp(`\\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof)\\.?${SP}+${CAP}(?:${SP}+${CAP})?`, 'g');
/** "Beth here." */
const HERE = new RegExp(`\\b${CAP}(?=${SP}+here\\b)`, 'g');
/** A customer reply that is just "First Last," / "First Last." (answering "what's your name?"). */
const LINE_START_FULL_NAME = new RegExp(
  `^(Customer:${SP}+)${CAP}${SP}+${CAP}(?:${SP}+${CAP})?(?=${SP}*(?:[,.]|$))`,
  'gm',
);
const ANY_CAP = new RegExp(`\\b${CAP}\\b`, 'g');
/** "[NAME] Smith" → the following capitalized word is the surname. */
const NAME_THEN_CAP = new RegExp(`\\[NAME\\](?:${SP}+${CAP}){1,2}\\b`, 'g');
const SURNAME_THEN_NAME = new RegExp(`\\b${CAP}(?=${SP}*,?${SP}*\\[NAME\\])`, 'g');
const REPEATED_NAME = new RegExp(`\\[NAME\\](?:${SP}*\\[NAME\\])+`, 'g');

// Words a cue may be followed by that are clearly not names ("thanks Again", "Hi There").
const NOT_NAMES = new Set(
  `I Im The A An All And Again Agent Customer Everyone Team There Thanks Thank You Yes No Okay Ok So
  Sure Again Just Well Sorry Please Support Billing Technical Accounts Good Great`.split(/\s+/),
);

function isSentenceStart(text: string, index: number): boolean {
  const before = text.slice(0, index).trimEnd();
  return before === '' || /[.!?:]$/.test(before) || before.endsWith('\n');
}

function redactNames(text: string): string {
  const N = token('NAME');
  let out = text;

  out = out.replace(TITLE, N);
  out = out.replace(AFTER_CUE, (_m, cue: string, words: string) => {
    const first = words.split(/[ \t]+/)[0]!;
    return NOT_NAMES.has(first) ? `${cue}${words}` : `${cue}${N}`;
  });
  out = out.replace(LINE_START_FULL_NAME, (_m, prefix: string) => `${prefix}${N}`);
  out = out.replace(HERE, (w) => (NOT_NAMES.has(w) ? w : N));

  // Known names anywhere, as capitalized words. Unambiguous first names always go. Names that
  // double as words ("Bill", "May", "Price") stay only when they plainly start a sentence:
  // "Bill is too high" and "May I ask" keep the word; "Hi Bill" was already caught by a cue.
  out = out.replace(ANY_CAP, (word: string, offset: number, whole: string) => {
    // "Maria's" → look up "Maria", keep the possessive: "[NAME]'s".
    const possessive = /['’]s$/.test(word) ? word.slice(-2) : '';
    const base = possessive ? word.slice(0, -2) : word;
    if (FIRST_NAMES.has(base)) return N + possessive;
    if (!AMBIGUOUS_FIRST_NAMES.has(base) && !SURNAMES.has(base)) return word;
    const next = whole.slice(offset + word.length).match(/^[ \t]+([A-Za-z]+)/)?.[1];
    if (isSentenceStart(whole, offset) && next && /^(?:[a-z]|I\b)/.test(next)) return word;
    return N + possessive;
  });
  // "[NAME] Okonkwo-Reyes": a capitalized word right after a name is taken as the surname.
  out = out.replace(NAME_THEN_CAP, (m) => {
    const words = m.split(/[ \t]+/).slice(1);
    return words.every((w) => !NOT_NAMES.has(w)) ? N : m;
  });
  out = out.replace(SURNAME_THEN_NAME, (w) => (SURNAMES.has(w) ? N : w));
  return out.replace(REPEATED_NAME, N);
}

// ───────────── entry point ─────────────

function countTokens(text: string, kind: PiiKind): number {
  return text.split(token(kind)).length - 1;
}

/**
 * Replaces PII with typed tokens: [EMAIL], [PHONE], [ACCOUNT], [ADDRESS], [NAME].
 * Pure and idempotent. Counts are tokens added, never the values.
 */
export function redact(input: string): RedactionResult {
  let text = input;
  text = text.replace(EMAIL, token('EMAIL'));
  text = text.replace(PO_BOX, token('ADDRESS'));
  text = text.replace(ADDRESS, token('ADDRESS'));
  text = text.replace(PHONE, token('PHONE'));
  text = text.replace(ACCOUNT, token('ACCOUNT'));
  text = redactNames(text);

  const counts = Object.fromEntries(
    PII_KINDS.map((k) => [k, Math.max(0, countTokens(text, k) - countTokens(input, k))]),
  ) as RedactionCounts;
  return { text: text as RedactedTranscript, counts };
}

export function emptyCounts(): RedactionCounts {
  return { EMAIL: 0, PHONE: 0, ACCOUNT: 0, ADDRESS: 0, NAME: 0 };
}

export function addCounts(a: RedactionCounts, b: RedactionCounts): RedactionCounts {
  return Object.fromEntries(PII_KINDS.map((k) => [k, a[k] + b[k]])) as RedactionCounts;
}

export function formatCounts(c: RedactionCounts): string {
  return PII_KINDS.map((k) => `${k} ${c[k]}`).join(', ');
}
