/** Where an evidence quote was found in the transcript. */
export type EvidenceMatch = 'customer' | 'agent_only' | 'not_found';

/** Fraction of quote tokens that must appear, in order, within one turn. */
export const FUZZY_THRESHOLD = 0.85;

function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9[\]'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (s: string) => normalize(s).split(' ').filter(Boolean);

/** Length of the longest common subsequence of two token lists. */
function lcs(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 0; j < b.length; j++) {
      cur[j + 1] = x === b[j] ? prev[j]! + 1 : Math.max(prev[j + 1]!, cur[j]!);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function matches(quote: string, turn: string): boolean {
  const q = normalize(quote);
  if (q.length === 0) return false;
  if (normalize(turn).includes(q)) return true;
  const qt = tokens(quote);
  return lcs(qt, tokens(turn)) / qt.length >= FUZZY_THRESHOLD;
}

/**
 * Checks that `evidence` really appears in the transcript, tolerating case, punctuation,
 * curly quotes and small omissions. Customer turns are checked first.
 */
export function matchEvidence(evidence: string, transcript: string): EvidenceMatch {
  const turns = transcript.split('\n');
  const of = (speaker: string) =>
    turns.filter((t) => t.startsWith(`${speaker}:`)).map((t) => t.slice(speaker.length + 1));
  const customer = of('Customer');
  if (customer.some((t) => matches(evidence, t)) || matches(evidence, customer.join(' '))) {
    return 'customer';
  }
  return of('Agent').some((t) => matches(evidence, t)) ? 'agent_only' : 'not_found';
}
