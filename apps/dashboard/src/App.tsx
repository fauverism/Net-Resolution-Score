import { useEffect, useState } from 'react';

type Health = { ok: boolean; db: 'ready' | 'missing' };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main>
      <h1>Net Resolution Score</h1>
      {error && <p role="alert">API unreachable: {error}</p>}
      {!error && !health && <p>Loading…</p>}
      {health?.db === 'missing' && (
        <p>
          No database yet. Run <code>npm run seed</code>.
        </p>
      )}
      {health?.db === 'ready' && (
        <p>
          No reports yet. Run <code>npm run pipeline</code>.
        </p>
      )}
    </main>
  );
}
