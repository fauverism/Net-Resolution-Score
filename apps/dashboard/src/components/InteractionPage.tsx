import { InteractionDetailSchema, type InteractionDetail } from '@nrs/core';
import { apiUrl, useApi } from '../api.ts';
import { CATEGORY_NAMES, CHANNEL_NAMES } from '../format.ts';
import { interactionHref } from '../router.ts';
import { lineName } from './Dashboard.tsx';
import { Status } from './common.tsx';

type Recl = InteractionDetail['reclassifications'][number];

const RESOLVED_WORDS = {
  yes: 'yes',
  partial: "the agent said so, but the customer didn't confirm it",
  no: 'no',
} as const;

/** Why a category changed after scoring, in plain words. */
function explain(r: Recl, back: string): React.ReactNode {
  const other = r.link ? (
    <a href={interactionHref(r.link.otherInteractionId, back)}>{r.link.otherInteractionId}</a>
  ) : (
    'another conversation'
  );
  const to = CATEGORY_NAMES[r.toCategory];
  if (r.reason === 'false_resolution') {
    return (
      <>
        Counted as “{to}”: the customer came back about the same problem
        {r.link ? ` ${r.link.gapDays.toFixed(1)} days later` : ''} ({other}), so it wasn't really
        fixed.
      </>
    );
  }
  if (r.reason === 'repeat_contact') {
    return (
      <>
        Counted as “{to}” at best: this was a repeat contact about a problem first raised in {other}
        , so it wasn't fixed on the first try.
      </>
    );
  }
  return (
    <>
      Changed to “{to}” ({r.reason.replace(/_/g, ' ')}).
    </>
  );
}

export function InteractionPage({ id, back }: { id: string; back: string | null }) {
  const load = useApi(
    apiUrl(`interactions/${encodeURIComponent(id)}`, {}),
    InteractionDetailSchema,
  );
  const backHref = back ?? '#/';
  return (
    <>
      <p>
        <a href={backHref}>← Back</a>
      </p>
      {load.state === 'loading' && <Status>Loading conversation…</Status>}
      {load.state === 'error' && (
        <Status role="alert">Couldn't load this conversation: {load.message}</Status>
      )}
      {load.state === 'ready' && (
        <article className="detail">
          <h2>Conversation {load.data.interactionId}</h2>
          <dl className="facts">
            <div>
              <dt>Date</dt>
              <dd>{load.data.startedAt.slice(0, 10)}</dd>
            </div>
            <div>
              <dt>Handled by</dt>
              <dd>{CHANNEL_NAMES[load.data.channel]}</dd>
            </div>
            <div>
              <dt>Business line</dt>
              <dd>{lineName(load.data.businessLine)}</dd>
            </div>
            <div>
              <dt>Result</dt>
              <dd>
                {load.data.finalCategory ? (
                  <span className={`result result--${load.data.finalCategory}`}>
                    {CATEGORY_NAMES[load.data.finalCategory]}
                  </span>
                ) : (
                  'Not scored yet'
                )}
              </dd>
            </div>
          </dl>

          {load.data.reclassifications.length > 0 && (
            <section aria-labelledby="why-h" className="card">
              <h3 id="why-h">Why the result changed after review</h3>
              <ul>
                {load.data.reclassifications.map((r) => (
                  <li key={r.id}>
                    <p>{explain(r, interactionHref(load.data.interactionId, backHref))}</p>
                    {r.link?.why && (
                      <p className="muted">
                        Reviewer's note (AI, {Math.round((r.link.confidence ?? 0) * 100)}% sure):{' '}
                        {r.link.why}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {load.data.score?.status === 'scored' && (
            <section aria-labelledby="score-h" className="card">
              <h3 id="score-h">How it was scored</h3>
              <p>
                Goal: {load.data.score.output.customer_goal}. Fixed:{' '}
                {RESOLVED_WORDS[load.data.score.output.resolved]}. Effort:{' '}
                {load.data.score.output.effort} of 3. Asked for a person:{' '}
                {load.data.score.output.asked_for_human ? 'yes' : 'no'}. Gave up:{' '}
                {load.data.score.output.abandoned ? 'yes' : 'no'}.
              </p>
              {load.data.score.override && (
                <p>
                  Adjusted from “{CATEGORY_NAMES[load.data.score.override.from]}” to “
                  {CATEGORY_NAMES[load.data.score.override.to]}” to match these facts.
                </p>
              )}
            </section>
          )}

          <section aria-labelledby="transcript-h">
            <h3 id="transcript-h">Transcript (personal details removed)</h3>
            <ol className="transcript">
              {load.data.transcript.split('\n').map((line, i) => {
                const [who, ...rest] = line.split(': ');
                const agent = who === 'Agent';
                return (
                  <li key={i} className={agent ? 'turn turn--agent' : 'turn turn--customer'}>
                    <span className="turn__who">{agent ? 'Agent' : 'Customer'}</span>
                    <span>{rest.join(': ')}</span>
                  </li>
                );
              })}
            </ol>
          </section>

          <details className="card">
            <summary>Score details (JSON)</summary>
            <pre className="json" tabIndex={0}>
              {JSON.stringify(load.data.score, null, 2)}
            </pre>
          </details>
        </article>
      )}
    </>
  );
}
