/**
 * Append-only incident ledger.
 *
 * The domain is a log, so the store is a log. JSONL keeps the project to a single
 * `npm install` with no database and no native modules, and it gives an ops manager
 * the audit trail they would actually be asked for in an incident review.
 *
 * Writes are best-effort by design: a full disk must never take dispatch down.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Incident } from '../../shared/types';

const LOG_PATH = resolve(process.cwd(), 'data', 'incidents.jsonl');

let ready: Promise<void> | null = null;
let warned = false;

async function ensureDir(): Promise<void> {
  ready ??= mkdir(dirname(LOG_PATH), { recursive: true }).then(() => undefined);
  return ready;
}

/** One line per resolved incident: the decision, the outcome, and the human verdict. */
export async function logIncident(incident: Incident): Promise<void> {
  try {
    await ensureDir();
    const row = {
      id: incident.id,
      ts: incident.event.ts,
      site: incident.event.siteId,
      zone: incident.event.zoneId,
      type: incident.event.type,
      source: incident.event.sourceId,
      sensorConfidence: incident.event.sensorConfidence,
      engine: incident.engine,
      action: incident.decision?.action ?? null,
      priority: incident.decision?.priority ?? null,
      severity: incident.decision?.severity ?? null,
      falseAlarmProbability: incident.decision?.falseAlarmProbability ?? null,
      confidence: incident.decision?.confidence ?? null,
      decisionLatencyMs: incident.decisionLatencyMs,
      responderId: incident.dispatch?.responderId ?? null,
      accepted: incident.dispatch?.accepted ?? null,
      responseMs: incident.dispatch?.responseMs ?? null,
      outcome: incident.outcome,
      wasReal: incident.revealedTruth?.isReal ?? null,
      trueSeverity: incident.revealedTruth?.trueSeverity ?? null,
      feedback: incident.feedback?.verdict ?? null,
      correctedAction: incident.feedback?.correctedAction ?? null,
      evidence: incident.decision?.evidence.map((e) => `${e.kind}:${e.refId}`) ?? [],
    };
    await appendFile(LOG_PATH, `${JSON.stringify(row)}\n`, 'utf8');
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(`[sentry] incident ledger unavailable (${err instanceof Error ? err.message : err}); continuing without it.`);
    }
  }
}

export const LEDGER_PATH = LOG_PATH;
