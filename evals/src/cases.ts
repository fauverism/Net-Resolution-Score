import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  expectedFromGroundTruth,
  GoldenCaseSchema,
  GroundTruthFileSchema,
  stratifiedSample,
  type Channel,
  type EvalExpected,
} from '@nrs/core';
import { redact, type Db, type RedactedTranscript } from '@nrs/pipeline';
import { z } from 'zod';

/** One transcript to score, with what the scorer should say about it. */
export interface EvalCase {
  id: string;
  source: 'seed' | 'golden';
  channel: Channel;
  /** Redacted at load time: nothing unredacted is held past this point. */
  transcript: RedactedTranscript;
  expected: EvalExpected;
}

/**
 * Seed cases: labels from the seed's ground-truth file (validated), transcripts from the
 * db. A stratified sample by channel × expected category keeps rare cases in every run.
 */
export function loadSeedCases(
  db: Db,
  groundTruthFile: string,
  sampleSize: number | null,
): EvalCase[] {
  if (!existsSync(groundTruthFile)) {
    throw new Error(`No ground truth at ${groundTruthFile}. Run \`npm run seed\` first.`);
  }
  const parsed = GroundTruthFileSchema.safeParse(JSON.parse(readFileSync(groundTruthFile, 'utf8')));
  if (!parsed.success)
    throw new Error(`Invalid ${groundTruthFile}:\n${z.prettifyError(parsed.error)}`);

  const transcripts = new Map(
    (
      db.prepare('SELECT id, transcript FROM interactions').all() as {
        id: string;
        transcript: string;
      }[]
    ).map((r) => [r.id, r.transcript]),
  );
  const cases = parsed.data.labels.map((l): EvalCase => {
    const raw = transcripts.get(l.interactionId);
    if (raw === undefined) {
      throw new Error(
        `Interaction ${l.interactionId} from the ground truth isn't in the db. Re-run \`npm run seed\` so they match.`,
      );
    }
    return {
      id: l.interactionId,
      source: 'seed',
      channel: l.channel,
      transcript: redact(raw).text,
      expected: expectedFromGroundTruth(l),
    };
  });
  return sampleSize === null
    ? cases
    : stratifiedSample(
        cases,
        sampleSize,
        (c) => `${c.channel}/${c.expected.category}`,
        (c) => c.id,
      );
}

/**
 * Golden cases: hand-labeled real transcripts in <dir>/*.jsonl, one JSON object per line
 * (see evals/golden/README.md). Every line is validated; transcripts are redacted on load.
 */
export function loadGoldenCases(dir: string): EvalCase[] {
  if (!existsSync(dir)) return [];
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()) {
    const lines = readFileSync(path.join(dir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const where = `${file}:${i + 1}`;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        throw new Error(`${where}: not valid JSON`);
      }
      const parsed = GoldenCaseSchema.safeParse(json);
      if (!parsed.success) throw new Error(`${where}: ${z.prettifyError(parsed.error)}`);
      const id = `golden:${parsed.data.id}`;
      if (seen.has(id)) throw new Error(`${where}: duplicate id "${parsed.data.id}"`);
      seen.add(id);
      cases.push({
        id,
        source: 'golden',
        channel: parsed.data.channel,
        transcript: redact(parsed.data.transcript).text,
        expected: parsed.data.expected,
      });
    });
  }
  return cases;
}
