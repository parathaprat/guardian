/**
 * The worker: the one process that owns the world, ticks the simulator, runs
 * the agent, and writes to Postgres. Exactly one replica may run; see
 * DECISIONS.md (Decision 8) for why there's no leader election here.
 */

import 'dotenv/config';
import { OpsEngine } from './engine';
import { createCommandHandler } from './api/gateway';
import { createBus } from './bus';
import { openRepository, PostgresRepository } from './store/index';
import { EmbedClient, PgVectorIndex } from './learn/semantic';
import { engineStatus } from './agent/index';

const SEED = Number(process.env.SENTRY_SEED ?? 20260721);

process.on('unhandledRejection', (reason) => {
  console.error('[worker] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[worker] uncaught exception:', err);
});

const bus = createBus();
if (!bus) {
  console.error('[worker] REDIS_URL is required in split mode. '
    + 'For a single process, run src/server/index.ts instead.');
  process.exit(1);
}

const engine = new OpsEngine(Number.isFinite(SEED) ? SEED : 20260721);
const repo = await openRepository();
await engine.attach(repo);

// Semantic precedent needs both halves: somewhere to put vectors and something
// to produce them. Either missing and it falls back to structured similarity.
const embedUrl = process.env.EMBED_URL?.trim();
let semanticNote = 'off';
if (embedUrl && repo instanceof PostgresRepository) {
  engine.attachSemantic(new PgVectorIndex(new EmbedClient({ baseUrl: embedUrl }), repo));
  semanticNote = embedUrl;
} else if (embedUrl) {
  semanticNote = 'off, needs Postgres for pgvector';
}

engine.subscribe((e) => bus.publishEvent(e));
await bus.serve(createCommandHandler(engine));
bus.startHeartbeat();

const status = engineStatus();
console.log('');
console.log('  \x1b[1mguard\x1b[38;5;202m[ai]\x1b[0m\x1b[1mn\x1b[0m  worker');
console.log('  ' + '─'.repeat(52));
console.log(`  engine   ${status.engine === 'reasoner' ? 'REASONER · local, deterministic' : `${status.engine.toUpperCase()} · ${status.model}`}`);
console.log(`  store    ${repo.kind === 'postgres' ? 'Postgres, durable' : 'in-memory, volatile'}`);
console.log(`  semantic ${semanticNote}`);
console.log(`  seed     ${SEED}`);
console.log('');

engine.start();

let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`\n[worker] ${signal}, flushing and closing`);
    void engine.shutdown()
      .catch((err) => console.error('[worker] shutdown failed:', err))
      .finally(() => bus.close().finally(() => process.exit(0)));
  });
}
