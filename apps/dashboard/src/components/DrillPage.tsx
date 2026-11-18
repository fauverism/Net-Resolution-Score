import { DrillResponseSchema, type DrillQuery } from '@nrs/core';
import { useState } from 'react';
import { apiUrl, useApi } from '../api.ts';
import { CATEGORY_NAMES, CHANNEL_NAMES, formatRange } from '../format.ts';
import { dashboardHref, drillHref, interactionHref } from '../router.ts';
import { lineName } from './Dashboard.tsx';
import { Status } from './common.tsx';

const PAGE = 50;

export function DrillPage({ query }: { query: DrillQuery }) {
  const load = useApi(apiUrl('drill', query), DrillResponseSchema);
  const [page, setPage] = useState(0);
  const self = drillHref(query);

  return (
    <>
      <p>
        <a href={dashboardHref(query)}>← Back to the dashboard</a>
      </p>
      {load.state === 'loading' && <Status>Loading conversations…</Status>}
      {load.state === 'error' && (
        <Status role="alert">Couldn't load these conversations: {load.message}</Status>
      )}
      {load.state === 'ready' && (
        <>
          <h2>{load.data.title}</h2>
          <p className="muted">
            {load.data.total} conversation{load.data.total === 1 ? '' : 's'},{' '}
            {formatRange(query.from, query.to)}
            {query.line ? `, ${lineName(query.line)}` : ''}. Open one to read it and see how it was
            scored.
          </p>
          {load.data.total === 0 ? (
            <p className="card">Nothing to show for this selection.</p>
          ) : (
            <>
              <div className="table-scroll">
                <table className="table">
                  <caption className="visually-hidden">{load.data.title}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Conversation</th>
                      <th scope="col">Handled by</th>
                      <th scope="col">Business line</th>
                      <th scope="col">Result</th>
                      <th scope="col">Changed after review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {load.data.items.slice(page * PAGE, (page + 1) * PAGE).map((i) => (
                      <tr key={i.interactionId}>
                        <td>{i.startedAt.slice(0, 10)}</td>
                        <td>
                          <a href={interactionHref(i.interactionId, self)}>{i.interactionId}</a>
                        </td>
                        <td>{CHANNEL_NAMES[i.channel]}</td>
                        <td>{lineName(i.businessLine)}</td>
                        <td>
                          {i.category ? (
                            <span className={`result result--${i.category}`}>
                              {CATEGORY_NAMES[i.category]}
                            </span>
                          ) : (
                            <span className="muted">Not scored yet</span>
                          )}
                        </td>
                        <td>{i.reclassified ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {load.data.total > PAGE && (
                <nav className="pager" aria-label="Pages">
                  <button
                    type="button"
                    className="button"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </button>
                  <span aria-live="polite">
                    Page {page + 1} of {Math.ceil(load.data.total / PAGE)}
                  </span>
                  <button
                    type="button"
                    className="button"
                    disabled={(page + 1) * PAGE >= load.data.total}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </button>
                </nav>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
