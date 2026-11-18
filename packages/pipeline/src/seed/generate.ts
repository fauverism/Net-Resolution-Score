import {
  categorize,
  type Category,
  type Channel,
  type Customer,
  type Effort,
  type GroundTruthFile,
  type GroundTruthLabel,
  type Interaction,
  type PiiMention,
  type SurveyResponse,
} from '@nrs/core';
import { Ctx, type JourneyVars } from './ctx.ts';
import { BUSINESS_LINES, GOALS_BY_LINE, type BusinessLine, type Goal } from './goals.ts';
import { AGENT_NAMES, makePersona, type Persona } from './pii.ts';
import { createRng, type Rng } from './rng.ts';
import { buildTranscript, type OutcomeKind } from './transcript.ts';

export interface GenerateOptions {
  seed: number;
  customers: number;
  /** Approximate target; the result lands within a few of it. */
  interactions: number;
  days: number;
  /** Exclusive end of the data period. Fixed by default so output is reproducible. */
  end: Date;
  /** Used only for the ground-truth `trueCategory`. */
  returnWindowDays: number;
  surveyRate: number;
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  seed: 42,
  customers: 500,
  interactions: 3000,
  days: 60,
  end: new Date('2026-11-15T00:00:00Z'),
  returnWindowDays: 7,
  surveyRate: 0.2,
};

export interface SeedData {
  customers: Customer[];
  interactions: Interaction[];
  surveys: SurveyResponse[];
  groundTruth: GroundTruthFile;
}

const DAY = 86_400_000;

// ───────────── tuning: the patterns the pipeline should find ─────────────

const CHANNEL_MIX: Record<Channel, number> = { ai_agent: 0.55, human: 0.3, hybrid: 0.15 };
const LINE_MIX: Record<BusinessLine, number> = {
  billing: 0.35,
  tech_support: 0.4,
  account_changes: 0.25,
};

/**
 * Sequential conditional probabilities: abandon → escape → false resolution → resolved,
 * otherwise unresolved. Billing on the AI channel is deliberately much worse.
 */
interface OutcomeRates {
  abandon: number;
  escape: number;
  falseResolution: number;
  resolve: number;
  effort: Record<'1' | '2' | '3', number>;
}

const RATES: Record<Channel, Record<BusinessLine, OutcomeRates>> = {
  ai_agent: {
    billing: {
      abandon: 0.09,
      escape: 0.22,
      falseResolution: 0.24,
      resolve: 0.55,
      effort: { 1: 0.4, 2: 0.38, 3: 0.22 },
    },
    tech_support: {
      abandon: 0.07,
      escape: 0.14,
      falseResolution: 0.14,
      resolve: 0.9,
      effort: { 1: 0.7, 2: 0.22, 3: 0.08 },
    },
    account_changes: {
      abandon: 0.06,
      escape: 0.12,
      falseResolution: 0.1,
      resolve: 0.94,
      effort: { 1: 0.76, 2: 0.19, 3: 0.05 },
    },
  },
  human: {
    billing: {
      abandon: 0.03,
      escape: 0.04,
      falseResolution: 0.03,
      resolve: 0.84,
      effort: { 1: 0.55, 2: 0.33, 3: 0.12 },
    },
    tech_support: {
      abandon: 0.04,
      escape: 0.04,
      falseResolution: 0.03,
      resolve: 0.8,
      effort: { 1: 0.5, 2: 0.35, 3: 0.15 },
    },
    account_changes: {
      abandon: 0.03,
      escape: 0.03,
      falseResolution: 0.02,
      resolve: 0.88,
      effort: { 1: 0.6, 2: 0.3, 3: 0.1 },
    },
  },
  // Hybrid "escape" = the customer asked for the handoff (counts as escalated).
  hybrid: {
    billing: {
      abandon: 0.06,
      escape: 0.3,
      falseResolution: 0.04,
      resolve: 0.74,
      effort: { 1: 0.25, 2: 0.5, 3: 0.25 },
    },
    tech_support: {
      abandon: 0.06,
      escape: 0.3,
      falseResolution: 0.04,
      resolve: 0.78,
      effort: { 1: 0.25, 2: 0.5, 3: 0.25 },
    },
    account_changes: {
      abandon: 0.05,
      escape: 0.3,
      falseResolution: 0.04,
      resolve: 0.84,
      effort: { 1: 0.25, 2: 0.5, 3: 0.25 },
    },
  },
};

/** Chance and delay (days) of a return contact about the same goal, by outcome. */
const RETURNS: Record<OutcomeKind, { p: number; min: number; max: number }> = {
  false_resolution: { p: 1, min: 1, max: 6 },
  unresolved: { p: 0.45, min: 1, max: 12 },
  abandoned: { p: 0.5, min: 0.05, max: 4 },
  escaped: { p: 0.4, min: 1, max: 6 },
  resolved: { p: 0.04, min: 9, max: 20 }, // a recurrence, outside the default window
};
const MAX_RETURN_DEPTH = 2;

const PLANS = ['Basic 100', 'Standard 300', 'Plus 500', 'Gig 1000'] as const;
const DEVICES = ['iPhone 15', 'Pixel 8', 'Galaxy S23', 'iPad', 'iPhone 13'] as const;

// ───────────── generation ─────────────

interface Draft {
  key: number;
  customerIdx: number;
  channel: Channel;
  businessLine: BusinessLine;
  goal: Goal;
  start: Date;
  kind: OutcomeKind;
  effort: Effort;
  requestedHandoff: boolean;
  transcript: string;
  pii: PiiMention[];
  prevKey: number | null;
  nextKey: number | null;
}

function money(rng: Rng, min: number, max: number): string {
  return `$${rng.int(min, max)}.${String(rng.int(0, 99)).padStart(2, '0')}`;
}

function journeyVars(rng: Rng, periodStart: Date): JourneyVars {
  const plan = rng.pick(PLANS);
  const charge = new Date(periodStart.getTime() + rng.int(0, 50) * DAY);
  return {
    amount: money(rng, 35, 180),
    newAmount: money(rng, 60, 240),
    chargeDate: charge.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }),
    plan,
    newPlan: rng.pick(PLANS.filter((p) => p !== plan)),
    device: rng.pick(DEVICES),
    errorCode: `E-${rng.int(100, 999)}`,
    speed: String(rng.int(8, 60)),
    ref: `REF-${rng.int(100000, 999999)}`,
    prevWhen: '',
  };
}

function describeGap(prev: Date, now: Date): string {
  const days = (now.getTime() - prev.getTime()) / DAY;
  if (days < 1) return 'earlier today';
  if (days < 2) return 'yesterday';
  if (days < 7) {
    const weekday = prev.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    return `on ${weekday}`;
  }
  return 'last week';
}

function sampleStart(rng: Rng, channel: Channel, from: number, to: number): Date {
  const day = Math.floor(from / DAY) + Math.floor(rng.next() * ((to - from) / DAY));
  // Humans staff 8:00–20:00 UTC; the AI is always on but busier in the day.
  const hour =
    channel === 'ai_agent' ? (rng.chance(0.8) ? rng.int(7, 22) : rng.int(0, 23)) : rng.int(8, 19);
  return new Date(day * DAY + hour * 3_600_000 + rng.int(0, 3599) * 1000);
}

/** Moves a time into staffed hours for human/hybrid, keeping it after `after` and before `end`. */
function staffedTime(rng: Rng, channel: Channel, at: number, after: number, end: number): Date {
  if (channel === 'ai_agent') return new Date(at);
  const hour = new Date(at).getUTCHours();
  if (hour >= 8 && hour < 20) return new Date(at);
  const dayStart = Math.floor(at / DAY) * DAY;
  const candidate =
    dayStart + (hour < 8 ? 0 : DAY) + rng.int(8, 11) * 3_600_000 + rng.int(0, 3599) * 1000;
  return new Date(candidate > after && candidate < end ? candidate : at);
}

function planOutcome(rng: Rng, channel: Channel, line: BusinessLine) {
  const r = RATES[channel][line];
  const effort = Number(rng.weighted(r.effort)) as Effort;
  const hybrid = channel === 'hybrid';
  const requestedHandoff = hybrid && rng.chance(r.escape);
  let kind: OutcomeKind;
  if (rng.chance(r.abandon)) kind = 'abandoned';
  else if (!hybrid && rng.chance(r.escape)) kind = 'escaped';
  else if (rng.chance(r.falseResolution)) kind = 'false_resolution';
  else if (rng.chance(r.resolve)) kind = 'resolved';
  else kind = 'unresolved';
  return { kind, effort, requestedHandoff };
}

export function generate(opts: GenerateOptions = DEFAULT_GENERATE_OPTIONS): SeedData {
  const rng = createRng(opts.seed);
  const end = opts.end.getTime();
  const start = end - opts.days * DAY;
  const periodStart = new Date(start);

  const personas: Persona[] = Array.from({ length: opts.customers }, () => makePersona(rng));
  // Heavy-tailed activity: a few customers contact support a lot.
  const activity = personas.map(() => (-Math.log(1 - rng.next())) ** 1.5);
  const activityTotal = activity.reduce((s, w) => s + w, 0);
  const pickCustomer = () => {
    let r = rng.next() * activityTotal;
    for (let i = 0; i < activity.length; i++) {
      r -= activity[i]!;
      if (r < 0) return i;
    }
    return activity.length - 1;
  };

  const drafts: Draft[] = [];

  const makeDraft = (
    customerIdx: number,
    goal: Goal,
    vars: JourneyVars,
    timeFor: (channel: Channel) => Date,
    prev: Draft | null,
  ): Draft => {
    const channel = rng.weighted(CHANNEL_MIX);
    const at = timeFor(channel);
    const outcome = planOutcome(rng, channel, goal.businessLine);
    const agentName = rng.pick(AGENT_NAMES);
    const v = { ...vars, prevWhen: prev ? describeGap(prev.start, at) : '' };
    const ctx = new Ctx(rng, personas[customerIdx]!, v, agentName);
    const transcript = buildTranscript(ctx, {
      channel,
      goal,
      ...outcome,
      isReturn: prev !== null,
    });
    const d: Draft = {
      key: drafts.length,
      customerIdx,
      channel,
      businessLine: goal.businessLine,
      goal,
      start: at,
      ...outcome,
      transcript,
      pii: ctx.pii,
      prevKey: prev?.key ?? null,
      nextKey: null,
    };
    drafts.push(d);
    return d;
  };

  const makeJourney = (customerIdx: number) => {
    const line = rng.weighted(LINE_MIX);
    const goal = rng.pick(GOALS_BY_LINE[line]);
    const vars = journeyVars(rng, periodStart);
    let d = makeDraft(customerIdx, goal, vars, (ch) => sampleStart(rng, ch, start, end), null);
    for (let depth = 0; depth < MAX_RETURN_DEPTH; depth++) {
      const ret = RETURNS[d.kind];
      if (!rng.chance(ret.p)) break;
      const at = d.start.getTime() + rng.float(ret.min, ret.max) * DAY;
      if (at >= end) break; // happens after the data period: unobserved
      const prev = d;
      const next = makeDraft(
        customerIdx,
        goal,
        vars,
        (ch) => staffedTime(rng, ch, at, prev.start.getTime(), end),
        prev,
      );
      d.nextKey = next.key;
      d = next;
    }
  };

  // Everyone gets at least one journey; the rest follow activity.
  for (let i = 0; i < opts.customers && drafts.length < opts.interactions; i++) makeJourney(i);
  while (drafts.length < opts.interactions) makeJourney(pickCustomer());

  // Stable chronological IDs.
  const ordered = [...drafts].sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.key - b.key,
  );
  const idOf = new Map<number, string>();
  ordered.forEach((d, i) => idOf.set(d.key, `int_${String(i + 1).padStart(5, '0')}`));
  const customerId = (i: number) => `cus_${String(i + 1).padStart(4, '0')}`;

  const customers: Customer[] = personas.map((_, i) => ({
    id: customerId(i),
    createdAt: new Date(start - rng.int(30, 1200) * DAY).toISOString(),
  }));

  const interactions: Interaction[] = ordered.map((d) => ({
    id: idOf.get(d.key)!,
    customerId: customerId(d.customerIdx),
    channel: d.channel,
    startedAt: d.start.toISOString(),
    transcript: d.transcript,
    businessLine: d.businessLine,
  }));

  const labels: GroundTruthLabel[] = ordered.map((d) => {
    const next = d.nextKey === null ? null : drafts[d.nextKey]!;
    const returnAfterDays = next
      ? Math.round(((next.start.getTime() - d.start.getTime()) / DAY) * 100) / 100
      : null;
    const facts = {
      firstContact: d.prevKey === null,
      effort: d.effort,
      escalated: d.kind === 'escaped' || d.requestedHandoff,
      abandoned: d.kind === 'abandoned',
    };
    const resolved = d.kind === 'resolved';
    const visiblyResolved = resolved || d.kind === 'false_resolution';
    return {
      interactionId: idOf.get(d.key)!,
      customerId: customerId(d.customerIdx),
      channel: d.channel,
      businessLine: d.businessLine,
      goalId: d.goal.id,
      goal: d.goal.summary,
      startedAt: d.start.toISOString(),
      resolved,
      visiblyResolved,
      falseResolution: d.kind === 'false_resolution',
      ...facts,
      previousInteractionId: d.prevKey === null ? null : idOf.get(d.prevKey)!,
      returnInteractionId: d.nextKey === null ? null : idOf.get(d.nextKey)!,
      returnAfterDays,
      transcriptCategory: categorize({
        ...facts,
        resolved: visiblyResolved,
        returnedWithinWindow: false,
      }),
      trueCategory: categorize({
        ...facts,
        resolved,
        returnedWithinWindow: returnAfterDays !== null && returnAfterDays <= opts.returnWindowDays,
      }),
      pii: d.pii,
    };
  });

  const surveys = generateSurveys(rng, labels, opts.surveyRate, end);

  return {
    customers,
    interactions,
    surveys,
    groundTruth: {
      version: 1,
      seed: opts.seed,
      periodStart: periodStart.toISOString(),
      periodEnd: opts.end.toISOString(),
      returnWindowDays: opts.returnWindowDays,
      labels,
    },
  };
}

const CATEGORY_VALUE: Record<Category, number> = { promoter: 1, passive: 0, detractor: -1 };

/** Experience score in [−1, 1]: recency-weighted mean of true categories. */
export function experienceScore(labels: readonly GroundTruthLabel[]): number {
  let sum = 0;
  let weights = 0;
  labels.forEach((l, i) => {
    const w = 1 + i; // later interactions matter more
    sum += w * CATEGORY_VALUE[l.trueCategory];
    weights += w;
  });
  return weights === 0 ? 0 : sum / weights;
}

/** NPS for ~surveyRate of customers: driven by true experience, plus noise. */
function generateSurveys(
  rng: Rng,
  labels: readonly GroundTruthLabel[],
  surveyRate: number,
  end: number,
): SurveyResponse[] {
  const byCustomer = new Map<string, GroundTruthLabel[]>();
  for (const l of labels) {
    const list = byCustomer.get(l.customerId) ?? [];
    list.push(l);
    byCustomer.set(l.customerId, list);
  }
  const surveys: SurveyResponse[] = [];
  for (const [customerId, list] of byCustomer) {
    if (!rng.chance(surveyRate)) continue;
    const exp = experienceScore(list);
    const npsScore = Math.max(0, Math.min(10, Math.round(rng.normal(6.8 + 2.6 * exp, 1.8))));
    const last = new Date(list[list.length - 1]!.startedAt).getTime();
    const respondedAt = Math.min(last + rng.float(0.5, 5) * DAY, end - 60_000);
    surveys.push({
      customerId,
      npsScore,
      respondedAt: new Date(Math.max(respondedAt, last + 60_000)).toISOString(),
    });
  }
  return surveys.sort((a, b) => a.respondedAt.localeCompare(b.respondedAt));
}

export { BUSINESS_LINES };
