# Golden set

Hand-labeled real transcripts, scored alongside the seed cases on every `npm run eval`.
Seed transcripts come from templates; a golden set tells you whether the scorer holds up on
how your customers actually talk.

## Format

One JSON object per line in any `*.jsonl` file in this folder. `example.jsonl.example` shows
the shape (the loader skips it, so it never counts toward results):

```text
{"id": "2026-11-ticket-4812", "channel": "ai_agent", "transcript": "Customer: ...\nAgent: ...", "expected": {"category": "passive", "resolved": "partial", "effort": 1, "asked_for_human": false, "abandoned": false}, "notes": "AI claimed the refund; customer only said ok"}
```

- `transcript`: alternating `Customer:` / `Agent:` lines.
- `expected`: what a careful reader of **this transcript alone** should conclude, using the
  rules in `packages/pipeline/prompts/scorer.v1.md`. Don't use what happened afterwards (a
  return a week later is the link stage's job, not the scorer's).
- `expected.effort`: 1–3, per the scorer prompt. It separates promoter from passive, so a
  wrong effort explains a lot of category misses.
- `notes`: optional, for whoever labels the next batch.

Every line is validated when the eval runs; a bad line fails with its file and line number.

## Personal data

Transcripts are redacted in memory before anything is sent to the model, but these files
hold the originals. `*.jsonl` here is gitignored so real transcripts aren't committed by
accident. Keep golden files somewhere access-controlled, or redact them before saving
(the same `redact()` the pipeline uses).

## Labeling tips

- Label 50–100 conversations, with every channel and category represented, before trusting
  the numbers. Under 30 per segment, treat accuracy as a rough signal.
- Have two people label the same 20 and compare. Where they disagree, the rule is unclear,
  and the scorer will struggle too.
