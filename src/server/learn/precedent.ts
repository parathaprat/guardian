/**
 * CHANNEL D — precedent retrieval.
 *
 * A bounded ring buffer of resolved incidents with a weighted feature
 * similarity. Cheap, explainable, and — unlike an embedding index — it can tell
 * an ops manager exactly why a case was retrieved.
 *
 * Only post-resolution facts are indexed (action taken, outcome). EventTruth is
 * never read here; `outcome` is the revealed signal and is already in the ledger.
 */

import type {
  AgentActionKind, EventType, Incident, Precedent as PrecedentRecord, ResolutionOutcome,
  SecurityEvent, SimTime, SourceKind,
} from '../../shared/types';
import { ACTION_LABELS, EVENT_LABELS } from '../../shared/types';
import type { PrecedentStore, WorldState } from '../contracts';

const CAPACITY = 400;
/** Below this, "no precedent" is the honest answer. */
const SIMILARITY_FLOOR = 0.28;

// Feature weights, summing to 1.
const W_TYPE = 0.34;
const W_ZONE = 0.22;
const W_SITE = 0.08;
const W_HOUR = 0.16;
const W_SOURCE = 0.10;
const W_CONFIDENCE = 0.10;

/** Coarse families so a near-miss type still retrieves something useful. */
const FAMILY: Record<EventType, string> = {
  door_forced: 'intrusion',
  glass_break: 'intrusion',
  perimeter_breach: 'intrusion',
  tailgating: 'intrusion',
  badge_anomaly: 'intrusion',
  motion_detected: 'presence',
  loitering: 'presence',
  vehicle_unauthorized: 'presence',
  package_theft: 'presence',
  person_down: 'safety',
  fire_alarm: 'safety',
  panic_button: 'safety',
  door_propped: 'infrastructure',
  camera_offline: 'infrastructure',
  robot_obstruction: 'infrastructure',
  noise_complaint: 'infrastructure',
};

const OUTCOME_PHRASE: Record<ResolutionOutcome, string> = {
  true_positive: 'confirmed real',
  false_alarm: 'confirmed false alarm',
  missed: 'missed — escalated on its own',
  declined: 'responder declined',
  unresolved: 'unresolved',
};

const ACTION_PAST: Record<AgentActionKind, string> = {
  dispatch: 'dispatched',
  escalate: 'escalated',
  monitor: 'monitored',
  suppress: 'suppressed',
};

interface IndexedIncident {
  incidentId: string;
  eventId: string;
  ts: SimTime;
  siteId: string;
  zoneId: string;
  zoneCode: string;
  zoneLabel: string;
  type: EventType;
  sourceId: string;
  sourceKind: SourceKind;
  sensorConfidence: number;
  hour: number;
  action: AgentActionKind;
  outcome: ResolutionOutcome;
  summary: string;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Shortest distance around a 24h clock, 0..12. */
function circularHourDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
}

function hhmm(ts: SimTime): string {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export class Precedent implements PrecedentStore {
  private buf: IndexedIncident[] = [];
  private seen = new Set<string>();

  /** `world` is optional so the store can be constructed standalone in tests. */
  constructor(private world?: WorldState) {}

  index(incident: Incident): void {
    // Only resolved cases carry a learning signal.
    if (!incident.outcome || !incident.decision) return;

    const ev = incident.event;
    const zone = this.world?.zoneById.get(ev.zoneId);
    const zoneCode = zone?.code ?? ev.zoneId.split(/[-_]/).slice(-1)[0] ?? ev.zoneId;
    const zoneLabel = zone?.name ?? zoneCode;
    const ts = incident.resolvedAt ?? incident.createdAt;

    const rec: IndexedIncident = {
      incidentId: incident.id,
      eventId: ev.id,
      ts,
      siteId: ev.siteId,
      zoneId: ev.zoneId,
      zoneCode,
      zoneLabel,
      type: ev.type,
      sourceId: ev.sourceId,
      sourceKind: ev.sourceKind,
      sensorConfidence: ev.sensorConfidence,
      hour: new Date(ev.ts).getUTCHours() + new Date(ev.ts).getUTCMinutes() / 60,
      action: incident.decision.action,
      outcome: incident.outcome,
      summary: '',
    };
    rec.summary =
      `${zoneLabel} · ${EVENT_LABELS[ev.type].toLowerCase()} · ${hhmm(ev.ts)} · ` +
      `${ACTION_PAST[rec.action]} · ${OUTCOME_PHRASE[rec.outcome]}`;

    if (this.seen.has(incident.id)) {
      const at = this.buf.findIndex((r) => r.incidentId === incident.id);
      if (at >= 0) this.buf[at] = rec;
      return;
    }

    this.buf.push(rec);
    this.seen.add(incident.id);
    if (this.buf.length > CAPACITY) {
      for (const dropped of this.buf.splice(0, this.buf.length - CAPACITY)) {
        this.seen.delete(dropped.incidentId);
      }
    }
  }

  similar(event: SecurityEvent, k: number): PrecedentRecord[] {
    if (k <= 0 || this.buf.length === 0) return [];
    const hour = new Date(event.ts).getUTCHours() + new Date(event.ts).getUTCMinutes() / 60;

    const scored: Array<{ rec: IndexedIncident; similarity: number }> = [];
    for (const rec of this.buf) {
      if (rec.eventId === event.id) continue;
      const similarity = this.score(event, hour, rec);
      if (similarity < SIMILARITY_FLOOR) continue;
      scored.push({ rec, similarity });
    }

    scored.sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      if (b.rec.ts !== a.rec.ts) return b.rec.ts - a.rec.ts; // recency breaks ties
      return a.rec.incidentId < b.rec.incidentId ? -1 : 1;
    });

    return scored.slice(0, k).map(({ rec, similarity }) => ({
      incidentId: rec.incidentId,
      ts: rec.ts,
      zoneCode: rec.zoneCode,
      type: rec.type,
      similarity: Math.round(similarity * 1e4) / 1e4,
      action: rec.action,
      outcome: rec.outcome,
      summary: rec.summary,
    }));
  }

  size(): number {
    return this.buf.length;
  }

  reset(): void {
    this.buf = [];
    this.seen.clear();
  }

  private score(event: SecurityEvent, hour: number, rec: IndexedIncident): number {
    const typeScore =
      rec.type === event.type ? 1 : FAMILY[rec.type] === FAMILY[event.type] ? 0.4 : 0;

    let zoneScore = 0;
    if (rec.zoneId === event.zoneId) zoneScore = 1;
    else if (this.world?.zoneById.get(event.zoneId)?.adjacent.includes(rec.zoneId)) zoneScore = 0.5;
    else if (rec.siteId === event.siteId) zoneScore = 0.15;

    const siteScore = rec.siteId === event.siteId ? 1 : 0;
    const hourScore = clamp01(1 - circularHourDistance(hour, rec.hour) / 8);
    const sourceScore =
      rec.sourceId === event.sourceId ? 1 : rec.sourceKind === event.sourceKind ? 0.5 : 0;
    const confScore = clamp01(1 - Math.abs(rec.sensorConfidence - event.sensorConfidence));

    return (
      W_TYPE * typeScore +
      W_ZONE * zoneScore +
      W_SITE * siteScore +
      W_HOUR * hourScore +
      W_SOURCE * sourceScore +
      W_CONFIDENCE * confScore
    );
  }
}
