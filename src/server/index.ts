/**
 * guard[ai]n, server entrypoint.
 *
 * Serves the API, and the built console too when `dist/web` exists, so
 * `npm run build && npm start` gives a single-port production app.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { OpsEngine } from './engine';
import { createRouter } from './api/routes';
import { createIngestRouter } from './api/ingest';
import { LocalGateway } from './api/gateway';
import { engineStatus } from './agent/index';
import { openRepository, PostgresRepository } from './store/index';

const PORT = Number(process.env.PORT ?? 8787);
const SEED = Number(process.env.SENTRY_SEED ?? 20260721);

// A background failure must never silently kill dispatch.
process.on('unhandledRejection', (reason) => {
  console.error('[sentry] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[sentry] uncaught exception:', err);
});

const engine = new OpsEngine(Number.isFinite(SEED) ? SEED : 20260721);
// Opened before routes are mounted: ingest needs it for idempotency, and this
// avoids serving an empty world we're about to replace a moment later.
const repo = await openRepository();
await engine.attach(repo);

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Malformed JSON should be a 400, not an unhandled error page.
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'malformed JSON body' });
    return;
  }
  next(err);
});

app.get('/api/health', (_req, res) => {
  const store = repo instanceof PostgresRepository ? repo.health() : null;
  res.json({
    ok: true,
    engine: engineStatus().engine,
    seed: SEED,
    store: { kind: repo.kind, ...(store ?? {}) },
  });
});

const gateway = new LocalGateway(engine);
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
  const status = engineStatus();
  const mode = status.engine === 'reasoner'
    ? 'REASONER · local, deterministic'
    : `${status.engine.toUpperCase()} · ${status.model} · effort=${status.effort}`;

  console.log('');
  console.log('  \x1b[1mguard\x1b[38;5;202m[ai]\x1b[0m\x1b[1mn\x1b[0m  AI dispatch for physical security');
  console.log('  ' + '─'.repeat(52));
  console.log(`  api      http://127.0.0.1:${PORT}/api`);
  console.log(`  console  http://127.0.0.1:5173  (npm run dev)`);
  console.log(`  engine   ${mode}`);
  console.log(`  store    ${repo.kind === 'postgres' ? 'Postgres, durable' : 'in-memory, volatile'}`);
  console.log(`  seed     ${SEED}`);
  if (status.note) console.log(`  note     ${status.note.split('.')[0]}.`);
  console.log('');

  engine.start();
});

/**
 * Flush learned state before the process dies. Containers get SIGTERM and
 * about ten seconds; without this, learning since the last flush is lost.
 */
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`\n[sentry] ${signal}, flushing and closing`);
    server.close();
    void engine.shutdown()
      .catch((err) => console.error('[sentry] shutdown failed:', err))
      .finally(() => process.exit(0));
  });
}
