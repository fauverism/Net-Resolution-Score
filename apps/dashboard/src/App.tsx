import {
  MetaResponseSchema,
  SummaryResponseSchema,
  type MetaResponse,
  type PeriodQuery,
} from '@nrs/core';
import { useEffect, useRef, useState } from 'react';
import { apiUrl, useApi } from './api.ts';
import { DashboardView } from './components/Dashboard.tsx';
import { DrillPage } from './components/DrillPage.tsx';
import { InteractionPage } from './components/InteractionPage.tsx';
import { Status } from './components/common.tsx';
import { presetRange } from './format.ts';
import { drillHref, parseRoute, type Route } from './router.ts';

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function Dashboard({ meta, query }: { meta: MetaResponse; query: PeriodQuery }) {
  const load = useApi(apiUrl('summary', query), SummaryResponseSchema);
  if (load.state === 'loading') return <Status>Loading the latest numbers…</Status>;
  if (load.state === 'error')
    return <Status role="alert">Couldn't load the dashboard: {load.message}</Status>;
  return <DashboardView meta={meta} s={load.data} />;
}

export function App() {
  const route = useRoute();
  const meta = useApi(apiUrl('meta', {}), MetaResponseSchema);
  const main = useRef<HTMLElement>(null);

  // Move focus to the page on navigation, so keyboard and screen-reader users start at the top.
  const key = window.location.hash;
  // Compare with the last URL rather than counting runs: effects can run twice in dev.
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    main.current?.focus();
  }, [key]);

  let body;
  if (meta.state === 'loading') body = <Status>Loading…</Status>;
  else if (meta.state === 'error')
    body = <Status role="alert">Couldn't reach the data: {meta.message}</Status>;
  else if (!meta.data.latestDate)
    body = (
      <Status>
        No data yet. Run <code>npm run seed</code>.
      </Status>
    );
  else if (route.page === 'drill')
    body = <DrillPage key={drillHref(route.query)} query={route.query} />;
  else if (route.page === 'interaction') body = <InteractionPage id={route.id} back={route.back} />;
  else {
    const fallback = presetRange(meta.data.latestDate, 30);
    const query: PeriodQuery = {
      from: route.query.from ?? fallback.from,
      to: route.query.to ?? fallback.to,
      ...(route.query.line ? { line: route.query.line } : {}),
    };
    body = <Dashboard meta={meta.data} query={query} />;
  }

  return (
    <>
      {/* Moves focus without touching the hash, which the router owns. */}
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      {meta.state === 'ready' && meta.data.demo && (
        <p className="banner" role="note">
          <strong>Demo data.</strong> These numbers come from synthetic conversations scored with
          the test answer key, not from real customers or the live model.
        </p>
      )}
      <header className="masthead">
        <h1>
          <a href="#/">Customer outcomes</a>
        </h1>
        <p className="muted">Are customers getting their problems fixed, by AI and by people?</p>
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        {body}
      </main>
    </>
  );
}
