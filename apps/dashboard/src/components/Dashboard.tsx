import {
  CHANNELS,
  type Driver,
  type MetaResponse,
  type PeriodQuery,
  type RateReport,
  type SummaryResponse,
} from '@nrs/core';
import { useId, useState, type FormEvent } from 'react';
import {
  CHANNEL_NAMES,
  formatCount,
  formatNrs,
  formatPct,
  formatRange,
  presetRange,
} from '../format.ts';
import { dashboardHref, drillHref } from '../router.ts';
import { AiSuggested, CalibrationBadge, Delta, LowConfidence } from './common.tsx';
import { Trend } from './Trend.tsx';

const PRESETS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

export const lineName = (line: string) =>
  line.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// ───────────── filters ─────────────

export function Filters({ meta, query }: { meta: MetaResponse; query: PeriodQuery }) {
  const id = useId();
  const latest = meta.latestDate!;
  const preset = PRESETS.find((p) => {
    const r = presetRange(latest, p.days);
    return r.from === query.from && r.to === query.to;
  });
  const [custom, setCustom] = useState(!preset);
  const go = (q: Partial<PeriodQuery>) => {
    window.location.hash = dashboardHref({ ...query, ...q });
  };
  const applyCustom = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const from = String(f.get('from'));
    const to = String(f.get('to'));
    if (from && to && from <= to) go({ from, to });
  };

  return (
    <form className="filters" aria-label="Choose what to show" onSubmit={applyCustom}>
      <div className="field">
        <label htmlFor={`${id}-period`}>Period</label>
        <select
          id={`${id}-period`}
          value={custom ? 'custom' : String(preset?.days ?? 30)}
          onChange={(e) => {
            if (e.target.value === 'custom') return setCustom(true);
            setCustom(false);
            go(presetRange(latest, Number(e.target.value)));
          }}
        >
          {PRESETS.map((p) => (
            <option key={p.days} value={p.days}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom dates…</option>
        </select>
      </div>
      {custom && (
        <>
          <div className="field">
            <label htmlFor={`${id}-from`}>From</label>
            <input
              id={`${id}-from`}
              name="from"
              type="date"
              defaultValue={query.from}
              min={meta.earliestDate ?? undefined}
              max={latest}
              required
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-to`}>To</label>
            <input
              id={`${id}-to`}
              name="to"
              type="date"
              defaultValue={query.to}
              min={meta.earliestDate ?? undefined}
              max={latest}
              required
            />
          </div>
          <button type="submit" className="button button--primary">
            Apply dates
          </button>
        </>
      )}
      <div className="field">
        <label htmlFor={`${id}-line`}>Business line</label>
        <select
          id={`${id}-line`}
          value={query.line ?? ''}
          onChange={(e) => go({ line: e.target.value || undefined })}
        >
          <option value="">All business lines</option>
          {meta.businessLines.map((l) => (
            <option key={l} value={l}>
              {lineName(l)}
            </option>
          ))}
        </select>
      </div>
    </form>
  );
}

// ───────────── headline ─────────────

export function Headline({ s }: { s: SummaryResponse }) {
  const o = s.report.overall;
  const q = s.query;
  return (
    <section className="card headline" aria-labelledby="headline-h">
      <div className="headline__main">
        <h2 id="headline-h" className="headline__label">
          Net Resolution Score
        </h2>
        <p className="headline__value">
          <a
            href={drillHref(q)}
            aria-label={`Score ${formatNrs(o.nrs)}: see all ${o.n} conversations`}
          >
            {formatNrs(o.nrs)}
          </a>
        </p>
        <p className="headline__delta">
          <Delta value={o.delta} higherIsBetter />
        </p>
        <p className="headline__explain">
          Of {formatCount(o.n)} customers, the share whose problem was fixed easily minus the share
          who were let down. Ranges from −100 to +100.
        </p>
        {o.warning && <LowConfidence n={o.n} />}
      </div>
      <CalibrationBadge calibration={s.calibration} />
    </section>
  );
}

// ───────────── tiles ─────────────

function RateTile({
  title,
  explain,
  rate,
  href,
}: {
  title: string;
  explain: string;
  rate: RateReport;
  href: string;
}) {
  const id = useId();
  return (
    <section className="card tile" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <p className="tile__value">
        <a href={href} aria-label={`${formatPct(rate.pct)}: see the ${rate.count} conversations`}>
          {formatPct(rate.pct)}
        </a>
      </p>
      <p className="tile__sub">
        {formatCount(rate.count)} of {formatCount(rate.n)} {explain}
      </p>
      <Delta value={rate.delta} higherIsBetter={false} />
      {rate.warning && <LowConfidence n={rate.n} />}
    </section>
  );
}

export function Tiles({ s }: { s: SummaryResponse }) {
  const q = s.query;
  const { ai, human, gap, priorGap } = s.aiVsHuman;
  const gapDelta =
    gap === null || priorGap === null ? null : Math.round((gap - priorGap) * 10) / 10;
  const r = s.report.rates;
  return (
    <div className="tiles">
      <section className="card tile" aria-labelledby="tile-ai">
        <h3 id="tile-ai">AI agent vs. people</h3>
        <div className="tile__pair">
          <p>
            <span className="tile__small">AI agent</span>
            <a className="tile__value" href={drillHref({ ...q, channel: 'ai_agent' })}>
              {formatNrs(ai.nrs)}
            </a>
          </p>
          <p>
            <span className="tile__small">People</span>
            <a className="tile__value" href={drillHref({ ...q, channel: 'human' })}>
              {formatNrs(human.nrs)}
            </a>
          </p>
        </div>
        <p className="tile__sub">
          {gap === null ? (
            'Not enough data to compare.'
          ) : (
            <a href={drillHref({ ...q, channel: 'ai_agent', category: 'detractor' })}>
              {gap === 0
                ? 'AI and people score the same'
                : `AI is ${Math.abs(gap).toFixed(1)} pts ${gap < 0 ? 'behind' : 'ahead of'} people`}
            </a>
          )}
        </p>
        <Delta value={gapDelta} higherIsBetter label="Gap" />
        {(ai.warning || human.warning) && <LowConfidence n={Math.min(ai.n, human.n)} />}
      </section>
      <RateTile
        title="Asked for a person"
        explain="AI conversations"
        rate={r.escape}
        href={drillHref({ ...q, metric: 'escape' })}
      />
      <RateTile
        title="Told it was fixed, but it wasn't"
        explain="conversations that ended as “fixed”"
        rate={r.falseResolution.overall}
        href={drillHref({ ...q, metric: 'false_resolution' })}
      />
      <RateTile
        title="Gave up mid-conversation"
        explain="conversations"
        rate={r.abandonment.overall}
        href={drillHref({ ...q, metric: 'abandoned' })}
      />
    </div>
  );
}

// ───────────── drivers ─────────────

function DriverCard({ d, runId, q }: { d: Driver; runId: number; q: PeriodQuery }) {
  const id = useId();
  return (
    <li className="card driver" aria-labelledby={id}>
      <p className="driver__rank" aria-hidden="true">
        {d.rank}
      </p>
      <h3 id={id}>{d.driver}</h3>
      <p className="driver__share">
        <a href={drillHref({ ...q, metric: 'driver', driverRun: runId, driverRank: d.rank })}>
          {formatPct(d.pctOfDetractors)} of unhappy customers
        </a>{' '}
        <span className="muted">({d.volume} conversations)</span>
      </p>
      {d.warning && <LowConfidence n={d.volume} />}
      <dl className="mix" aria-label="Who handled these conversations">
        {CHANNELS.filter((c) => d.channelMix[c].n > 0).map((c) => (
          <div key={c} className="mix__row">
            <dt>{CHANNEL_NAMES[c]}</dt>
            <dd>
              <span
                className="mix__bar"
                style={{ inlineSize: `${d.channelMix[c].pct}%` }}
                aria-hidden="true"
              />
              {formatPct(d.channelMix[c].pct)}
            </dd>
          </div>
        ))}
      </dl>
      {d.representative && (
        <figure className="quote">
          <blockquote>“{d.representative.quote}”</blockquote>
          <figcaption className="muted">
            A customer, in their words (personal details removed)
          </figcaption>
        </figure>
      )}
      <p className="driver__owner">
        <span>Suggested owner: </span>
        <strong>{d.suggestedOwner?.value ?? 'No suggestion yet'}</strong>{' '}
        {d.suggestedOwner && <AiSuggested />}
      </p>
      {d.suggestedFix && (
        <details className="driver__fix">
          <summary>
            Suggested first step <AiSuggested />
          </summary>
          <p>{d.suggestedFix.value}</p>
        </details>
      )}
    </li>
  );
}

export function Drivers({ s }: { s: SummaryResponse }) {
  const dr = s.drivers;
  return (
    <section className="drivers" aria-labelledby="drivers-h">
      <h2 id="drivers-h">What to fix next</h2>
      {!dr || dr.top.length === 0 ? (
        <p className="card">
          No analysis yet. It appears after the next pipeline run (
          <code>npm run pipeline -- drivers</code>).
        </p>
      ) : (
        <>
          <p className="muted">
            The biggest reasons customers were let down, weighted by how badly.
            {!dr.matchesPeriod &&
              ` From the latest analysis, which covers ${formatRange(dr.periodStart.slice(0, 10), new Date(Date.parse(dr.periodEnd) - 1).toISOString().slice(0, 10))}.`}
            {s.query.line && ' Covers all business lines.'} Owners and first steps are suggestions
            to start from, not decisions.
          </p>
          <ol className="drivers__list">
            {dr.top.map((d) => (
              <DriverCard key={d.rank} d={d} runId={dr.runId} q={s.query} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

export function DashboardView({ meta, s }: { meta: MetaResponse; s: SummaryResponse }) {
  return (
    <>
      <Filters meta={meta} query={s.query} />
      <p className="period" aria-live="polite">
        Showing {formatRange(s.query.from, s.query.to)}
        {s.query.line ? `, ${lineName(s.query.line)}` : ', all business lines'}. Compared with the{' '}
        {s.report.periodStart === s.report.priorEnd
          ? 'same number of days just before.'
          : 'previous period.'}
      </p>
      <Headline s={s} />
      <Tiles s={s} />
      <Drivers s={s} />
      <Trend points={s.trend} query={s.query} />
    </>
  );
}
