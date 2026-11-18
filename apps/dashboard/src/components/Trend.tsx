import { CHANNELS, type Channel, type PeriodQuery, type TrendPoint } from '@nrs/core';
import { useId, useState } from 'react';
import { linePath, spreadLabels, xFor, yFor } from '../chart.ts';
import { bucketDates, CHANNEL_NAMES, formatDay, formatNrs } from '../format.ts';
import { drillHref } from '../router.ts';

const W = 820;
const H = 300;
const PAD = { top: 16, right: 210, bottom: 40, left: 56 };
const GRID = [100, 50, 0, -50, -100];
/** Lines differ by dash pattern and marker shape as well as color. */
const STYLE: Record<Channel, { dash: string; marker: 'circle' | 'square' | 'diamond' }> = {
  ai_agent: { dash: '', marker: 'circle' },
  human: { dash: '8 4', marker: 'square' },
  hybrid: { dash: '2 4', marker: 'diamond' },
};

function Marker({ kind, x, y, hollow }: { kind: string; x: number; y: number; hollow: boolean }) {
  const common = { className: hollow ? 'marker marker--hollow' : 'marker' };
  if (kind === 'square') return <rect {...common} x={x - 4} y={y - 4} width={8} height={8} />;
  if (kind === 'diamond')
    return (
      <path {...common} d={`M${x},${y - 5.5}L${x + 5.5},${y}L${x},${y + 5.5}L${x - 5.5},${y}Z`} />
    );
  return <circle {...common} cx={x} cy={y} r={4.5} />;
}

/** NRS over time, one line per channel, labeled at the line's end; with a table view. */
export function Trend({ points, query }: { points: TrendPoint[]; query: PeriodQuery }) {
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  const left = PAD.left;
  const right = W - PAD.right;
  const top = PAD.top;
  const bottom = H - PAD.bottom;

  const series = CHANNELS.map((c) => ({
    channel: c,
    points: points.map((p, i) =>
      p.byChannel[c].nrs === null
        ? null
        : {
            x: xFor(i, points.length, left, right),
            y: yFor(p.byChannel[c].nrs!, top, bottom),
            n: p.byChannel[c].n,
            v: p.byChannel[c].nrs!,
          },
    ),
  }));
  const ends = series
    .map((s) => ({ s, last: [...s.points].reverse().find((p) => p !== null) ?? null }))
    .filter((e) => e.last !== null);
  const labels = spreadLabels(
    ends.map((e) => ({ key: e.s.channel, y: e.last!.y })),
    20,
    top + 6,
    bottom,
  );

  const first = points[0];
  const last = points.at(-1);
  const summary = last
    ? `Weekly score by channel from ${formatDay(first!.start)} to ${formatDay(last.end)}. Latest week: ` +
      CHANNELS.map((c) => `${CHANNEL_NAMES[c]} ${formatNrs(last.byChannel[c].nrs)}`).join(', ') +
      '. Use "Show as table" for every value.'
    : 'No weekly data yet.';

  return (
    <section className="card trend" aria-labelledby={`${id}-h`}>
      <div className="card__head">
        <h2 id={`${id}-h`}>Score over time, by who handled it</h2>
        <button
          type="button"
          className="button"
          aria-pressed={asTable}
          aria-controls={`${id}-view`}
          onClick={() => setAsTable((t) => !t)}
        >
          {asTable ? 'Show as chart' : 'Show as table'}
        </button>
      </div>
      <div id={`${id}-view`}>
        {points.length === 0 ? (
          <p>No weekly data yet.</p>
        ) : asTable ? (
          <div className="table-scroll">
            <table className="table">
              <caption>
                Weekly score by channel. Each number opens the conversations behind it.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Week</th>
                  {CHANNELS.map((c) => (
                    <th scope="col" key={c}>
                      {CHANNEL_NAMES[c]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {points.map((p) => {
                  const dates = bucketDates(p.start, p.end);
                  return (
                    <tr key={p.start}>
                      <th scope="row">
                        {formatDay(p.start)} –{' '}
                        {formatDay(new Date(Date.parse(p.end) - 1).toISOString())}
                      </th>
                      {CHANNELS.map((c) => {
                        const s = p.byChannel[c];
                        return (
                          <td key={c}>
                            {s.n === 0 ? (
                              '—'
                            ) : (
                              <a href={drillHref({ ...dates, line: query.line, channel: c })}>
                                {formatNrs(s.nrs)}
                                <span className="muted">
                                  {' '}
                                  (n {s.n}
                                  {s.warning ? ', low confidence' : ''})
                                </span>
                              </a>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <figure className="chart">
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-sum`}>
              <title id={`${id}-sum`}>{summary}</title>
              {GRID.map((g) => (
                <g key={g}>
                  <line
                    className={g === 0 ? 'grid grid--zero' : 'grid'}
                    x1={left}
                    x2={right}
                    y1={yFor(g, top, bottom)}
                    y2={yFor(g, top, bottom)}
                  />
                  <text className="axis" x={left - 8} y={yFor(g, top, bottom) + 4} textAnchor="end">
                    {formatNrs(g)}
                  </text>
                </g>
              ))}
              {points.map((p, i) =>
                i % Math.ceil(points.length / 6) === 0 || i === points.length - 1 ? (
                  <text
                    key={p.start}
                    className="axis"
                    x={xFor(i, points.length, left, right)}
                    y={H - 12}
                    textAnchor="middle"
                  >
                    {formatDay(p.start)}
                  </text>
                ) : null,
              )}
              {series.map((s) => (
                <g key={s.channel} className={`series series--${s.channel}`}>
                  <path
                    d={linePath(s.points)}
                    strokeDasharray={STYLE[s.channel].dash || undefined}
                  />
                  {s.points.map((pt, i) =>
                    pt ? (
                      <Marker
                        key={i}
                        kind={STYLE[s.channel].marker}
                        x={pt.x}
                        y={pt.y}
                        hollow={pt.n < 30}
                      />
                    ) : null,
                  )}
                </g>
              ))}
              {labels.map((l) => {
                const e = ends.find((x) => x.s.channel === l.key)!;
                return (
                  <g key={l.key} className={`series series--${l.key}`}>
                    <line
                      className="leader"
                      x1={e.last!.x + 6}
                      y1={e.last!.y}
                      x2={right + 10}
                      y2={l.y}
                    />
                    <text className="series__label" x={right + 14} y={l.y + 4}>
                      {CHANNEL_NAMES[l.key]} {formatNrs(e.last!.v)}
                    </text>
                  </g>
                );
              })}
            </svg>
            <figcaption className="muted">
              Each line is labeled at its end. Hollow points cover fewer than 30 conversations (low
              confidence). Lines also differ by pattern: solid, dashed, dotted.
            </figcaption>
          </figure>
        )}
      </div>
    </section>
  );
}
