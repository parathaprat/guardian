/**
 * Postgres persistence for a live console. Raw `pg` and hand-written SQL, no ORM.
 * Every write is best-effort and never awaited by the tick loop: a slow disk
 * costs durability, not dispatch. See DECISIONS.md Decision 8.
 */

import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Briefing, EngineStatus, Incident, LearningPoint, Metrics, SecurityEvent, SimControls,
} from '../../shared/types';
import type { MemorySnapshot, PersistedRun, Repository } from '../contracts';
import { highestSeq } from '../util/ids';

const HERE = dirname(fileURLToPath(import.meta.url));

/** How many incidents and events a restarted console reloads. Matches the engine caps. */
const LOAD_INCIDENTS = 400;
const LOAD_EVENTS = 200;

export interface PostgresOptions {
  connectionString: string;
  orgId?: string;
  /** Log the first N failures, then go quiet. A broken database should not become the log. */
  quietAfter?: number;
}

export class PostgresRepository implements Repository {
  readonly kind = 'postgres' as const;

  private pool: Pool;
  private orgId: string;
  private failures = 0;
  private lastError: string | null = null;
  private quietAfter: number;

  constructor(opts: PostgresOptions) {
    this.pool = new Pool({
      connectionString: opts.connectionString,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.orgId = opts.orgId ?? 'demo';
    this.quietAfter = opts.quietAfter ?? 5;
    // A pool-level error with no listener takes the process down.
    this.pool.on('error', (err) => this.note('pool', err));
  }

  async init(): Promise<void> {
    const ddl = readFileSync(resolve(HERE, 'schema.sql'), 'utf8');
    await this.pool.query(ddl);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Logs the first N failures then goes quiet, but keeps counting; `/api/health` reports the count so a systematic failure is never silent. */
  private note(where: string, err: unknown): void {
    this.failures += 1;
    this.lastError = err instanceof Error ? err.message : String(err);
    if (this.failures <= this.quietAfter) {
      console.error(`[store] ${where} failed: ${this.lastError}`);
      if (this.failures === this.quietAfter) {
        console.error('[store] further persistence errors will be counted, see /api/health');
      }
    }
  }

  health(): { failures: number; lastError: string | null } {
    return { failures: this.failures, lastError: this.lastError };
  }

  /** Every write goes through here, so one broken statement cannot reach the tick loop. */
  private async run(where: string, sql: string, params: unknown[]): Promise<void> {
    try {
      await this.pool.query(sql, params);
    } catch (err) {
      this.note(where, err);
    }
  }

  // ── run lifecycle ────────────────────────────────────────────────────────

  async openRun(seed: number): Promise<string> {
    const id = `run-${this.orgId}-${seed}`;
    await this.run('openRun', `
      INSERT INTO runs (id, org_id, seed) VALUES ($1, $2, $3)
      ON CONFLICT (org_id, seed) DO UPDATE SET updated_at = now()
    `, [id, this.orgId, seed]);
    return id;
  }

  async clearRun(runId: string): Promise<void> {
    // Children cascade from runs, but the run row itself must survive so the
    // reseeded world keeps its identity.
    await this.run('clearRun', 'DELETE FROM events WHERE run_id = $1', [runId]);
    await this.run('clearRun', 'DELETE FROM incidents WHERE run_id = $1', [runId]);
    await this.run('clearRun', 'DELETE FROM briefings WHERE run_id = $1', [runId]);
    await this.run('clearRun', 'DELETE FROM memory_snapshots WHERE run_id = $1', [runId]);
    await this.run('clearRun', 'UPDATE runs SET metrics = NULL, curve = NULL WHERE id = $1', [runId]);
  }

  async dropStrandedIncidents(runId: string): Promise<number> {
    try {
      const res = await this.pool.query(
        'DELETE FROM incidents WHERE run_id = $1 AND outcome IS NULL', [runId]);
      return res.rowCount ?? 0;
    } catch (err) {
      this.note('dropStrandedIncidents', err);
      return 0;
    }
  }

  async load(seed: number): Promise<PersistedRun | null> {
    try {
      const runId = `run-${this.orgId}-${seed}`;
      const run = await this.pool.query(
        'SELECT id, seed, controls, engine, metrics, curve FROM runs WHERE id = $1', [runId],
      );
      if (run.rowCount === 0) return null;

      const [events, incidents, memory, briefings, maxId] = await Promise.all([
        this.pool.query(
          `SELECT event FROM (
             SELECT sim_ts, jsonb_build_object(
               'id', event_id, 'ts', sim_ts, 'siteId', site_id, 'zoneId', zone_id,
               'type', type, 'sourceKind', source_kind, 'sourceId', source_id,
               'description', description, 'sensorConfidence', sensor_confidence,
               'metadata', metadata) AS event
             FROM events WHERE run_id = $1 ORDER BY sim_ts DESC LIMIT $2
           ) t ORDER BY sim_ts DESC`,
          [runId, LOAD_EVENTS],
        ),
        this.pool.query(
          // Most recent first, so a long-lived run restores recent history, not its oldest.
          `SELECT incident_id, created_at_sim, status, engine, outcome, resolved_at_sim,
                  decision_latency_ms, event, decision, trace, dispatch, feedback,
                  revealed_truth, linked_incident_ids
             FROM incidents WHERE run_id = $1
            ORDER BY created_at_sim DESC LIMIT $2`,
          [runId, LOAD_INCIDENTS],
        ),
        this.pool.query(
          'SELECT calibration, responders, playbook, proposals FROM memory_snapshots WHERE run_id = $1',
          [runId],
        ),
        this.pool.query(
          'SELECT payload FROM briefings WHERE run_id = $1 ORDER BY created_at DESC LIMIT 12',
          [runId],
        ),
        // Ids are fixed-width zero-padded, so a lexical MAX is a numeric MAX.
        this.pool.query('SELECT max(incident_id) AS max_id FROM incidents WHERE run_id = $1', [runId]),
      ]);

      const r = run.rows[0] as {
        id: string; seed: string | number; controls: SimControls | null;
        engine: EngineStatus | null; metrics: Metrics | null; curve: LearningPoint[] | null;
      };

      return {
        runId: r.id,
        seed: Number(r.seed),
        controls: r.controls,
        engine: r.engine,
        events: events.rows.map((row) => row.event as SecurityEvent),
        incidents: incidents.rows.map(rowToIncident),
        maxIncidentSeq: highestSeq([maxId.rows[0]?.max_id].filter(Boolean) as string[]),
        memory: memory.rowCount === 0 ? null : {
          calibration: memory.rows[0].calibration,
          responders: memory.rows[0].responders,
          playbook: memory.rows[0].playbook,
          proposals: memory.rows[0].proposals,
        },
        briefings: briefings.rows.map((row) => row.payload as Briefing),
        metrics: r.metrics,
        curve: r.curve ?? [],
      };
    } catch (err) {
      this.note('load', err);
      return null;
    }
  }

  // ── writes ───────────────────────────────────────────────────────────────

  async saveEvent(runId: string, e: SecurityEvent): Promise<void> {
    await this.run('saveEvent', `
      INSERT INTO events (run_id, event_id, org_id, sim_ts, site_id, zone_id, type,
                          source_kind, source_id, description, sensor_confidence, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (run_id, event_id) DO NOTHING
    `, [
      runId, e.id, this.orgId, e.ts, e.siteId, e.zoneId, e.type,
      e.sourceKind, e.sourceId, e.description, e.sensorConfidence, JSON.stringify(e.metadata),
    ]);
  }

  async saveIncident(runId: string, i: Incident): Promise<void> {
    await this.run('saveIncident', `
      INSERT INTO incidents (
        run_id, incident_id, org_id, created_at_sim, status, engine, outcome,
        resolved_at_sim, decision_latency_ms, zone_id, event_type, event, decision,
        trace, dispatch, feedback, revealed_truth, linked_incident_ids, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
      ON CONFLICT (run_id, incident_id) DO UPDATE SET
        status = EXCLUDED.status,
        engine = EXCLUDED.engine,
        outcome = EXCLUDED.outcome,
        resolved_at_sim = EXCLUDED.resolved_at_sim,
        decision_latency_ms = EXCLUDED.decision_latency_ms,
        decision = EXCLUDED.decision,
        trace = EXCLUDED.trace,
        dispatch = EXCLUDED.dispatch,
        feedback = EXCLUDED.feedback,
        revealed_truth = EXCLUDED.revealed_truth,
        linked_incident_ids = EXCLUDED.linked_incident_ids,
        updated_at = now()
    `, [
      runId, i.id, this.orgId, i.createdAt, i.status, i.engine, i.outcome,
      i.resolvedAt, i.decisionLatencyMs, i.event.zoneId, i.event.type,
      JSON.stringify(i.event), i.decision ? JSON.stringify(i.decision) : null,
      JSON.stringify(i.trace), i.dispatch ? JSON.stringify(i.dispatch) : null,
      i.feedback ? JSON.stringify(i.feedback) : null,
      i.revealedTruth ? JSON.stringify(i.revealedTruth) : null,
      i.linkedIncidentIds,
    ]);
  }

  async saveMemory(runId: string, snap: MemorySnapshot): Promise<void> {
    await this.run('saveMemory', `
      INSERT INTO memory_snapshots (run_id, org_id, calibration, responders, playbook, proposals, taken_at)
      VALUES ($1,$2,$3,$4,$5,$6, now())
      ON CONFLICT (run_id) DO UPDATE SET
        calibration = EXCLUDED.calibration,
        responders  = EXCLUDED.responders,
        playbook    = EXCLUDED.playbook,
        proposals   = EXCLUDED.proposals,
        taken_at    = now()
    `, [
      runId, this.orgId, JSON.stringify(snap.calibration), JSON.stringify(snap.responders),
      JSON.stringify(snap.playbook), JSON.stringify(snap.proposals),
    ]);
  }

  async saveBriefing(runId: string, b: Briefing): Promise<void> {
    await this.run('saveBriefing', `
      INSERT INTO briefings (run_id, briefing_id, org_id, created_at_sim, payload)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (run_id, briefing_id) DO UPDATE SET payload = EXCLUDED.payload
    `, [runId, b.id, this.orgId, b.createdAt, JSON.stringify(b)]);
  }

  async saveMetrics(runId: string, metrics: Metrics, curve: LearningPoint[]): Promise<void> {
    await this.run('saveMetrics',
      'UPDATE runs SET metrics = $2, curve = $3, updated_at = now() WHERE id = $1',
      [runId, JSON.stringify(metrics), JSON.stringify(curve)]);
  }

  async saveControls(runId: string, controls: SimControls, engine: EngineStatus): Promise<void> {
    await this.run('saveControls',
      'UPDATE runs SET controls = $2, engine = $3, updated_at = now() WHERE id = $1',
      [runId, JSON.stringify(controls), JSON.stringify(engine)]);
  }

  // ── pgvector, for semantic precedent ─────────────────────────────────────

  /** pgvector's wire format is a bracketed literal, not a Postgres array, so the vector is stringified rather than passed as `number[]`. */
  async saveEmbedding(runId: string, incidentId: string, vector: number[]): Promise<void> {
    await this.run('saveEmbedding',
      'UPDATE incidents SET embedding = $3::vector WHERE run_id = $1 AND incident_id = $2',
      [runId, incidentId, `[${vector.join(',')}]`]);
  }

  /** `<=>` is cosine distance in 0..2; vectors are normalised so `1 - distance` reads as similarity. Resolved incidents only, since an open one is not yet precedent. */
  async nearest(runId: string, vector: number[], k: number): Promise<Array<{ incidentId: string; similarity: number }>> {
    try {
      const res = await this.pool.query(
        `SELECT incident_id, 1 - (embedding <=> $2::vector) AS similarity
           FROM incidents
          WHERE run_id = $1 AND embedding IS NOT NULL AND outcome IS NOT NULL
          ORDER BY embedding <=> $2::vector
          LIMIT $3`,
        [runId, `[${vector.join(',')}]`, k],
      );
      return res.rows.map((r) => ({
        incidentId: r.incident_id as string,
        similarity: Number(r.similarity),
      }));
    } catch (err) {
      this.note('nearest', err);
      return [];
    }
  }

  /** `ON CONFLICT DO NOTHING` plus a rowCount check is the whole concurrency story: one racing insert wins, the loser gets false. */
  async claimIngestKey(key: string, eventId: string): Promise<boolean> {
    try {
      const res = await this.pool.query(
        `INSERT INTO ingest_keys (org_id, idempotency_key, event_id)
         VALUES ($1,$2,$3) ON CONFLICT (org_id, idempotency_key) DO NOTHING`,
        [this.orgId, key, eventId],
      );
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      this.note('claimIngestKey', err);
      // Failing open on a database error would let a duplicate through; failing
      // closed would drop a real alarm. A real alarm is worth more.
      return true;
    }
  }
}

interface IncidentRow {
  incident_id: string;
  created_at_sim: string | number;
  status: Incident['status'];
  engine: Incident['engine'];
  outcome: Incident['outcome'];
  resolved_at_sim: string | number | null;
  decision_latency_ms: number | null;
  event: Incident['event'];
  decision: Incident['decision'];
  trace: Incident['trace'];
  dispatch: Incident['dispatch'];
  feedback: Incident['feedback'];
  revealed_truth: Incident['revealedTruth'];
  linked_incident_ids: string[];
}

/** BIGINT arrives as a string from `pg`, which would silently poison every timestamp. */
function rowToIncident(row: IncidentRow): Incident {
  return {
    id: row.incident_id,
    event: row.event,
    createdAt: Number(row.created_at_sim),
    status: row.status,
    decision: row.decision,
    trace: row.trace ?? [],
    decisionLatencyMs: row.decision_latency_ms,
    dispatch: row.dispatch,
    feedback: row.feedback,
    resolvedAt: row.resolved_at_sim === null ? null : Number(row.resolved_at_sim),
    outcome: row.outcome,
    revealedTruth: row.revealed_truth,
    engine: row.engine,
    linkedIncidentIds: row.linked_incident_ids ?? [],
  };
}
