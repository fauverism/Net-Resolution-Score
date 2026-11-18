import type { Channel, Effort } from '@nrs/core';
import type { Ctx, Line } from './ctx.ts';
import {
  ACCEPT_CLAIM,
  AI_ESCAPE_RESPONSE,
  AI_GREET,
  ANYTHING_ELSE,
  ASK_HUMAN,
  ASK_SUPERVISOR,
  EFFORT_FRICTION,
  ESCAPE_REACTION,
  FRUSTRATED,
  GOODBYE,
  HANDOFF_ACK,
  HANDOFF_WAIT,
  HUMAN_AFTER_HANDOFF,
  HUMAN_GREET,
  NO_THANKS,
  SORRY_CLOSE,
  SUPERVISOR_RESPONSE,
  TEAM_NAME,
  VERIFY,
  handoffAi,
  type Goal,
} from './goals.ts';

export const MIN_TURNS = 4;
export const MAX_TURNS = 20;

export type OutcomeKind = 'resolved' | 'false_resolution' | 'unresolved' | 'escaped' | 'abandoned';

export interface TranscriptPlan {
  channel: Channel;
  goal: Goal;
  kind: OutcomeKind;
  effort: Effort;
  isReturn: boolean;
  /** Hybrid only: the customer asked for a human (vs. the AI handing off on its own). */
  requestedHandoff: boolean;
}

type Speaker = 'C' | 'A';
interface Step {
  s: Speaker;
  line: Line;
}

const C = (line: Line): Step => ({ s: 'C', line });
const A = (line: Line): Step => ({ s: 'A', line });

/** Turns after merging consecutive same-speaker steps. */
function turnCount(steps: readonly Step[]): number {
  let n = 0;
  let prev: Speaker | null = null;
  for (const { s } of steps) {
    if (s !== prev) n++;
    prev = s;
  }
  return n;
}

function takeDistinct<T>(ctx: Ctx, items: readonly T[], n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(ctx.rng.next() * pool.length), 1)[0]!);
  }
  return out;
}

const pick =
  (lines: readonly Line[]): Line =>
  (c) =>
    c.say(lines);

/** Builds alternating "Customer:" / "Agent:" turns for one interaction. */
export function buildTranscript(ctx: Ctx, plan: TranscriptPlan): string {
  const { rng } = ctx;
  const { goal, channel, kind, effort } = plan;
  const hybrid = channel === 'hybrid';

  // How many troubleshooting loops this effort level implies (the hybrid handoff is itself effort).
  const baseLoops = effort === 1 ? 0 : effort === 2 ? rng.int(1, 2) : rng.int(3, 4);
  let loops = Math.max(0, baseLoops - (hybrid ? 1 : 0));
  const friction = effort === 3;
  const minProbes = hybrid || kind === 'abandoned' ? 1 : 0;
  const probes = takeDistinct(ctx, goal.probes, rng.int(minProbes, 2));
  const troubleshoot = takeDistinct(ctx, goal.troubleshoot, goal.troubleshoot.length);
  const [verifyAsk, verifyAnswer] = rng.pick(VERIFY);

  // Fixed choices for the variable parts, so re-planning below doesn't change them.
  const opener = plan.isReturn && rng.chance(0.75) ? goal.returnOpen : goal.open;
  const greet = channel === 'human' ? HUMAN_GREET : AI_GREET;
  const aiLoops = hybrid && effort >= 2 ? 1 : 0;
  const tailA = rng.chance(0.6);
  const tailB = rng.chance(0.5);
  const abandonFrac = rng.next();
  const escapeFrac = rng.next();
  const frictionPair = rng.pick(EFFORT_FRICTION);
  // fix[i] and confirm[i] describe the same remedy, so pick them together.
  const fixIdx = rng.int(0, goal.fix.length - 1);
  const fixLine = goal.fix[fixIdx]!;
  const confirmLine = goal.confirm[fixIdx % goal.confirm.length]!;

  const plan_ = (nLoops: number): Step[] => {
    const loopSteps = (pairs: readonly (readonly [Line, Line])[]): Step[] =>
      pairs.flatMap(([a, c]) => [A(a), C(c)]);
    const humanPairs = [...troubleshoot.slice(aiLoops, aiLoops + nLoops)];
    if (friction) humanPairs.splice(Math.min(1, humanPairs.length), 0, frictionPair);

    const steps: Step[] = [
      C(pick(opener)),
      A((c) => `${c.say(greet)} ${verifyAsk(c)}`),
      C(verifyAnswer),
      ...loopSteps(probes),
    ];

    if (hybrid) {
      steps.push(...loopSteps(troubleshoot.slice(0, aiLoops)));
      if (plan.requestedHandoff) steps.push(C(pick(ASK_HUMAN)));
      steps.push(A(pick(handoffAi(TEAM_NAME[goal.businessLine]))));
      if (kind === 'abandoned') return [...steps, A(pick(HANDOFF_WAIT))];
      steps.push(C(pick(HANDOFF_ACK)), A(pick(HUMAN_AFTER_HANDOFF)));
    }

    const middle = [...steps, ...loopSteps(humanPairs)];

    switch (kind) {
      case 'resolved':
        return [
          ...middle,
          A(fixLine),
          C(confirmLine),
          ...(tailA ? [A(pick(ANYTHING_ELSE)), C(pick(NO_THANKS))] : []),
          ...(tailA && tailB ? [A(pick(GOODBYE))] : []),
        ];
      case 'false_resolution':
        return [
          ...middle,
          A(pick(goal.falseFix)),
          C(pick(ACCEPT_CLAIM)),
          ...(tailA ? [A(pick(GOODBYE))] : []),
        ];
      case 'unresolved':
        return [
          ...middle,
          A(pick(goal.cantFix)),
          C(pick(FRUSTRATED)),
          ...(tailA ? [A(pick(SORRY_CLOSE))] : []),
        ];
      case 'escaped': {
        // Customer bails out after some customer turn in the middle.
        const cuts = middle.flatMap((st, i) => (st.s === 'C' && i >= 2 ? [i] : []));
        const cut = cuts[Math.floor(escapeFrac * cuts.length)] ?? middle.length - 1;
        const human = channel === 'human';
        return [
          ...middle.slice(0, cut + 1),
          C(pick(human ? ASK_SUPERVISOR : ASK_HUMAN)),
          A(pick(human ? SUPERVISOR_RESPONSE : AI_ESCAPE_RESPONSE)),
          ...(tailA ? [C(pick(ESCAPE_REACTION))] : []),
        ];
      }
      case 'abandoned': {
        // Ends on an agent question the customer never answers.
        const cuts = middle.flatMap((st, i) => (st.s === 'A' && i >= 3 ? [i] : []));
        const cut = cuts[Math.floor(abandonFrac * cuts.length)] ?? middle.length - 1;
        return middle.slice(0, cut + 1);
      }
    }
  };

  let steps = plan_(loops);
  while (turnCount(steps) > MAX_TURNS && loops > 0) steps = plan_(--loops);

  // Render, merging consecutive same-speaker steps into one turn.
  const turns: { s: Speaker; text: string }[] = [];
  for (const st of steps) {
    const text = st.line(ctx);
    const last = turns[turns.length - 1];
    if (last && last.s === st.s) last.text += ` ${text}`;
    else turns.push({ s: st.s, text });
  }
  return turns.map((t) => `${t.s === 'C' ? 'Customer' : 'Agent'}: ${t.text}`).join('\n');
}
