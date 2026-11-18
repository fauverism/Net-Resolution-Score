import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PROMPT_VERSION = 'scorer.v1';

export interface ScorerPrompt {
  /** e.g. "scorer.v1", from prompts/scorer.v1.md. Stored on every score row. */
  version: string;
  text: string;
  /** Content hash, so an in-place edit of a prompt file can't reuse stale cache entries. */
  sha256: string;
}

/** Loads packages/pipeline/prompts/<version>.md. New wording means a new version file. */
export function loadPrompt(version = DEFAULT_PROMPT_VERSION): ScorerPrompt {
  if (!/^[a-z0-9_-]+\.v\d+$/.test(version)) throw new Error(`Invalid prompt version: ${version}`);
  const text = readFileSync(
    fileURLToPath(new URL(`../../prompts/${version}.md`, import.meta.url)),
    'utf8',
  );
  return { version, text, sha256: createHash('sha256').update(text).digest('hex') };
}
