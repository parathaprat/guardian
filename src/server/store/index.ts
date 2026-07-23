/**
 * Which repository the process gets: `DATABASE_URL` set means Postgres, unset
 * means in-memory. The eval CLI never sets it, which is how `npm run verify`
 * stays hermetic. See DECISIONS.md Decision 8.
 */

import type { Repository } from '../contracts';
import { InMemoryRepository } from './memory';
import { PostgresRepository } from './postgres';

export { InMemoryRepository } from './memory';
export { PostgresRepository } from './postgres';

export function createRepository(env: NodeJS.ProcessEnv = process.env): Repository {
  const url = env.DATABASE_URL?.trim();
  if (!url) return new InMemoryRepository();
  return new PostgresRepository({
    connectionString: url,
    orgId: env.GUARDAIN_ORG?.trim() || 'demo',
  });
}

/** Open the repository, degrading to in-memory if Postgres will not come up (e.g. still booting). */
export async function openRepository(env: NodeJS.ProcessEnv = process.env): Promise<Repository> {
  const repo = createRepository(env);
  if (repo.kind === 'memory') return repo;
  try {
    await repo.init();
    return repo;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[store] Postgres unavailable, running without durability: ${msg}`);
    await repo.close().catch(() => undefined);
    return new InMemoryRepository();
  }
}
