import { isWithinReturnWindow } from './categorize.ts';
import type { Category, Channel, LinkFlag, LinkStatus, LinkerOutput, Resolved } from './schemas.ts';

export interface ReturnWindowConfig {
  /** From RETURN_WINDOW_DAYS (default 7). */
  defaultDays: number;
  /** Per-business-line overrides, e.g. { billing: 14 }. */
  byBusinessLine: Readonly<Record<string, number>>;
}

/** Per-business-line override → env default (CLAUDE.md order). */
export function returnWindowDaysFor(businessLine: string, cfg: ReturnWindowConfig): number {
  return Object.hasOwn(cfg.byBusinessLine, businessLine)
    ? cfg.byBusinessLine[businessLine]!
    : cfg.defaultDays;
}

/** One interaction as the candidate finder sees it. `resolved`/`category` are null when unscored. */
export interface LinkableInteraction {
  interactionId: string;
  customerId: string;
  businessLine: string;
  channel: Channel;
  startedAt: string;
  resolved: Resolved | null;
  category: Category | null;
}

export interface ReturnCandidate {
  a: LinkableInteraction;
  b: LinkableInteraction;
  gapDays: number;
  /** The window that applied: A's business line. */
  windowDays: number;
}

const DAY = 86_400_000;

/**
 * Deterministic stage 1: pairs (A, B) for the same customer where A was scored
 * resolved = "yes" and B starts after A, within the return window for A's business line.
 * A that is already a detractor is skipped (reclassifying it changes nothing).
 * B can be any later interaction, scored or not, in any business line: the LLM decides
 * whether it's about the same goal.
 */
export function findReturnCandidates(
  interactions: readonly LinkableInteraction[],
  cfg: ReturnWindowConfig,
): ReturnCandidate[] {
  const byCustomer = Map.groupBy(interactions, (i) => i.customerId);
  const out: ReturnCandidate[] = [];
  for (const list of byCustomer.values()) {
    const sorted = [...list].sort(
      (x, y) =>
        x.startedAt.localeCompare(y.startedAt) || x.interactionId.localeCompare(y.interactionId),
    );
    sorted.forEach((a, i) => {
      if (a.resolved !== 'yes' || a.category === null || a.category === 'detractor') return;
      const windowDays = returnWindowDaysFor(a.businessLine, cfg);
      const aStart = new Date(a.startedAt);
      for (const b of sorted.slice(i + 1)) {
        const bStart = new Date(b.startedAt);
        if (bStart.getTime() - aStart.getTime() > windowDays * DAY) break;
        if (!isWithinReturnWindow(aStart, bStart, windowDays)) continue; // same instant
        out.push({ a, b, gapDays: (bStart.getTime() - aStart.getTime()) / DAY, windowDays });
      }
    });
  }
  return out;
}

export const LINK_CONFIDENCE_THRESHOLD = 0.7;

/** Stage 2 decision: same goal at confidence ≥ threshold is a confirmed return. */
export function decideLink(o: LinkerOutput, threshold = LINK_CONFIDENCE_THRESHOLD): LinkStatus {
  if (!o.same_goal) return 'rejected';
  return o.confidence >= threshold ? 'confirmed' : 'unconfirmed';
}

/** The AI said it was resolved, and a human had to finish the job. */
export function linkFlags(aChannel: Channel, bChannel: Channel): LinkFlag[] {
  return aChannel === 'ai_agent' && (bChannel === 'human' || bChannel === 'hybrid')
    ? ['ai_resolved_human_finished']
    : [];
}
