# nrs — Net Resolution Score

NRS replaces sentiment-only NPS with an **outcome** measure, scored from every
customer interaction, whether a human or an AI agent handled it.

## The metric

`NRS = %promoters − %detractors`, range **−100 to +100**.

| Category  | Rule                                                                 |
|-----------|----------------------------------------------------------------------|
| Promoter  | Resolved on first try **and** effort = 1                             |
| Passive   | Resolved, but effort 2–3                                             |
| Detractor | Unresolved, escalated, abandoned, **or** customer returned about the same goal within the return window |

- **Return window**: defaults to 7 days. Never hardcode it. Resolve it in this
  order: per-business-line override → env `NRS_RETURN_WINDOW_DAYS` → `7`.
- **Channels**: `ai_agent | human | hybrid`. Every metric must be reportable per channel.

## Non-negotiables

1. **Never inflate.** If the scorer is uncertain between two categories, it
   picks the LOWER one (Promoter > Passive > Detractor). This applies to
   prompts, parsing fallbacks and tie-breaks in code.
2. **Redact PII before any transcript leaves the process**: LLM calls, logs,
   exports, fixtures. Redaction runs before scoring, never after.
3. **Model comes from env `ANTHROPIC_MODEL`.** Never hardcode a model name in
   code, tests, or fixtures. Fail fast if it's unset.
4. **Validate every external boundary with Zod**: LLM output, file imports and
   API requests/responses. Invalid LLM output means retry once, then fall back to
   the lowest defensible category and flag it. Never guess upward.

## Conventions

- TypeScript `strict`, ESM only (`"type": "module"`).
- All score math (categorize, NRS, percentages, window checks) lives in
  **pure functions** in `packages/core`, each with Vitest tests. No I/O, clock or env reads.
- Keep side effects (DB, network, LLM) in `packages/pipeline` and apps.

## Layout

```
packages/core       types, Zod schemas, pure score math
packages/pipeline   ingest → redact → score → link → aggregate
apps/dashboard      Vite + React UI
data/               SQLite db, fixtures (PII-free)
evals/              scorer accuracy evals against labeled transcripts
```

Pipeline stages:
- **ingest**: parse and validate raw interactions.
- **redact**: strip PII.
- **score**: Anthropic API → Zod-validated category and effort.
- **link**: detect same-goal returns within the window.
- **aggregate**: NRS by channel and business line.

## Commands

```bash
npm run seed       # load fixtures into data/ SQLite
npm run pipeline   # run ingest → aggregate end to end
npm run eval       # run scorer evals in /evals
npm run dev        # start the dashboard
npm test           # Vitest across all packages
```

## Env

- `ANTHROPIC_API_KEY`: required for scoring.
- `ANTHROPIC_MODEL`: required. The scoring model.
- `NRS_RETURN_WINDOW_DAYS`: optional, default `7`.

## Before you finish a change

- Is new score math pure, and does it have a test?
- Can the change raise a score under uncertainty? If yes, fix it.
- Could any unredacted text reach the network or logs?
- Can the metric be split by channel?
