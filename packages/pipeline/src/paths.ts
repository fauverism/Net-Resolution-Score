import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}
