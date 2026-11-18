import {
  CategorySchema,
  ChannelSchema,
  DrillMetricSchema,
  type DrillQuery,
  type PeriodQuery,
} from '@nrs/core';

/** Hash routes, so every view (and every drill-down) has a shareable, back-button-friendly URL. */
export type Route =
  | { page: 'dashboard'; query: Partial<PeriodQuery> }
  | { page: 'drill'; query: DrillQuery }
  | { page: 'interaction'; id: string; back: string | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function periodParams(p: URLSearchParams): Partial<PeriodQuery> {
  const out: Partial<PeriodQuery> = {};
  const from = p.get('from');
  const to = p.get('to');
  const line = p.get('line');
  if (from && DAY.test(from)) out.from = from;
  if (to && DAY.test(to)) out.to = to;
  if (line && /^[a-z][a-z0-9_]*$/.test(line)) out.line = line;
  return out;
}

export function parseRoute(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#/, '').split('?');
  const p = new URLSearchParams(search);
  const interaction = path.match(/^\/interaction\/([A-Za-z0-9_:-]{1,64})$/);
  if (interaction) return { page: 'interaction', id: interaction[1]!, back: p.get('back') };

  if (path === '/drill') {
    const period = periodParams(p);
    if (period.from && period.to) {
      const num = (k: string) => {
        const n = Number(p.get(k));
        return Number.isInteger(n) && n > 0 ? n : undefined;
      };
      const metric = DrillMetricSchema.safeParse(p.get('metric') ?? 'all');
      const channel = ChannelSchema.safeParse(p.get('channel'));
      const category = CategorySchema.safeParse(p.get('category'));
      return {
        page: 'drill',
        query: {
          from: period.from,
          to: period.to,
          ...(period.line ? { line: period.line } : {}),
          metric: metric.success ? metric.data : 'all',
          ...(channel.success ? { channel: channel.data } : {}),
          ...(category.success ? { category: category.data } : {}),
          ...(num('driverRun') ? { driverRun: num('driverRun') } : {}),
          ...(num('driverRank') ? { driverRank: num('driverRank') } : {}),
        },
      };
    }
  }
  return { page: 'dashboard', query: periodParams(p) };
}

function qs(o: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function dashboardHref(q: Partial<PeriodQuery>): string {
  return `#/${qs({ from: q.from, to: q.to, line: q.line })}`;
}

export function drillHref(q: PeriodQuery & Partial<Omit<DrillQuery, keyof PeriodQuery>>): string {
  return `#/drill${qs({
    from: q.from,
    to: q.to,
    line: q.line,
    metric: q.metric && q.metric !== 'all' ? q.metric : undefined,
    channel: q.channel,
    category: q.category,
    driverRun: q.driverRun,
    driverRank: q.driverRank,
  })}`;
}

export function interactionHref(id: string, back: string): string {
  return `#/interaction/${encodeURIComponent(id)}${qs({ back })}`;
}
