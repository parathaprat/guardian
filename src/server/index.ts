/**
 * SENTRY, server entrypoint.
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
import { engineStatus } from './agent/index';

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
  res.json({ ok: true, engine: engineStatus().engine, seed: SEED });
});

app.use('/api', createRouter(engine));

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

app.listen(PORT, () => {
  const status = engineStatus();
  const mode = status.engine === 'reasoner'
    ? 'REASONER · local, deterministic'
    : `${status.engine.toUpperCase()} · ${status.model} · effort=${status.effort}`;

  console.log('');
  console.log('  \x1b[1mSENTRY\x1b[0m \x1b[38;5;202m■\x1b[0m  Calvis AI Dispatch');
  console.log('  ' + '─'.repeat(52));
  console.log(`  api      http://127.0.0.1:${PORT}/api`);
  console.log(`  console  http://127.0.0.1:5173  (npm run dev)`);
  console.log(`  engine   ${mode}`);
  console.log(`  seed     ${SEED}`);
  if (status.note) console.log(`  note     ${status.note.split('.')[0]}.`);
  console.log('');

  engine.start();
});
