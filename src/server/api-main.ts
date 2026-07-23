/**
 * The API process: HTTP, SSE, and nothing else. Holds no world/memory/clock,
 * so it's safe to run more than one; `src/server/index.ts` is still the
 * single-process version `npm run dev` runs. See DECISIONS.md (Decision 8).
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRouter } from './api/routes';
import { createIngestRouter } from './api/ingest';
import { RemoteGateway } from './api/gateway';
import { readSnapshot } from './api/read-model';
import { createBus } from './bus';
import { openRepository, PostgresRepository } from './store/index';
import { engineStatus } from './agent/index';

const PORT = Number(process.env.PORT ?? 8787);
const SEED = Number(process.env.SENTRY_SEED ?? 20260721);

process.on('unhandledRejection', (reason) => {
  console.error('[api] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[api] uncaught exception:', err);
});

const bus = createBus();
if (!bus) {
  console.error('[api] REDIS_URL is required in split mode. '
    + 'For a single process, run src/server/index.ts instead.');
  process.exit(1);
}

const repo = await openRepository();
await bus.relayEvents();

const seed = Number.isFinite(SEED) ? SEED : 20260721;
const gateway = new RemoteGateway(bus, () => readSnapshot(repo, seed));

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'malformed JSON body' });
    return;
  }
  next(err);
});

/**
 * Readiness is about this process, not the whole stack: a redeploying worker
 * shouldn't fail this replica's healthcheck since it can still serve the last
 * known world. Worker health is reported in the body for anyone who wants it.
 */
app.get('/api/health', (_req, res) => {
  const store = repo instanceof PostgresRepository ? repo.health() : null;
  res.json({
    ok: true,
    role: 'api',
    engine: engineStatus().engine,
    seed,
    store: { kind: repo.kind, ...(store ?? {}) },
  });
});

app.use('/api/v1', createIngestRouter(gateway, repo));
app.use('/api', createRouter(gateway));

const webDist = resolve(process.cwd(), 'dist', 'web');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(resolve(webDist, 'index.html'));
  });
}

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

const server = app.listen(PORT, () => {
  console.log('');
  console.log('  \x1b[1mguard\x1b[38;5;202m[ai]\x1b[0m\x1b[1mn\x1b[0m  api');
  console.log('  ' + '─'.repeat(52));
  console.log(`  http     http://0.0.0.0:${PORT}/api`);
  console.log(`  store    ${repo.kind}`);
  console.log(`  worker   over redis`);
  console.log(`  seed     ${seed}`);
  console.log('');
});

let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close();
    void Promise.allSettled([bus.close(), repo.close()]).then(() => process.exit(0));
  });
}
