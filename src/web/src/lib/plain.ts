/**
 * Plain-language vocabulary for the console. Operational words live here for a
 * shift supervisor to read at a glance; the technical fields (action enums,
 * weights, posteriors) stay available one disclosure away for anyone auditing them.
 */

import type {
  AgentActionKind, EvidenceRef, Incident, ResolutionOutcome,
} from '../../../shared/types';
import { EVENT_LABELS } from '../../../shared/types';

// ── What the agent decided ──────────────────────────────────────────────────

/** The verb, as a dispatcher would say it out loud. */
export const ACTION_PLAIN: Record<AgentActionKind, string> = {
  dispatch: 'Send a responder',
  escalate: 'Escalate now',
  monitor: 'Keep watching',
  suppress: 'Stand down',
};

/** The short form, for the queue card where width is scarce. */
export const ACTION_SHORT: Record<AgentActionKind, string> = {
  dispatch: 'Sending',
  escalate: 'Escalated',
  monitor: 'Watching',
  suppress: 'Stood down',
};

/** One sentence of consequence: what is happening in the building right now. */
export const ACTION_MEANS: Record<AgentActionKind, string> = {
  dispatch: 'A responder is on the way to the zone.',
  escalate: 'Supervisor notified and a responder committed. This sits at the top of the queue.',
  monitor: 'Nobody has been sent. Guardian is holding this open and watching for a second signal.',
  suppress: 'Closed without sending anyone. Guardian has learned this pattern here is usually nothing.',
};

// ── How sure the agent is ───────────────────────────────────────────────────

/**
 * A probability, in words. Bands are wide on purpose, a five-band scale reads
 * reliably at a glance; the exact number sits right next to it.
 */
export function likelihoodWord(pReal: number): string {
  if (!Number.isFinite(pReal)) return 'Unknown';
  if (pReal >= 0.8) return 'Very likely real';
  if (pReal >= 0.6) return 'Probably real';
  if (pReal >= 0.4) return 'Could go either way';
  if (pReal >= 0.2) return 'Probably nothing';
  return 'Almost certainly nothing';
}

/** Agreement / disagreement between the device and the agent, as a sentence. */
export function beliefGapNote(sensor: number, agent: number): string {
  const gap = agent - sensor;
  if (Math.abs(gap) < 0.08) return 'Guardian agrees with the device on this one.';
  const pts = Math.round(Math.abs(gap) * 100);
  return gap < 0
    ? `Guardian trusts this ${pts} points less than the device claims. Past alarms here mostly came to nothing.`
    : `Guardian trusts this ${pts} points more than the device claims. The history here says take it seriously.`;
}

// ── Where and what ──────────────────────────────────────────────────────────

/** "Fire alarm · Harbourview, Utility Corridor U-1" */
export function incidentHeadline(inc: Incident, zoneName?: string): string {
  const site = String(inc.event.metadata.site ?? '');
  const zone = zoneName ?? String(inc.event.metadata.zone ?? inc.event.zoneId);
  const where = [site, zone].filter(Boolean).join(', ');
  return where ? `${EVENT_LABELS[inc.event.type]} · ${where}` : EVENT_LABELS[inc.event.type];
}

const SOURCE_PLAIN: Record<string, string> = {
  robot: 'Patrol robot',
  fixed_sensor: 'Fixed sensor',
  guard_report: 'Guard report',
  access_control: 'Access control',
  tenant_call: 'Tenant call',
};

export function sourcePlain(kind: string): string {
  return SOURCE_PLAIN[kind] ?? kind.replace(/_/g, ' ');
}

// ── Evidence ────────────────────────────────────────────────────────────────

/** What kind of memory this is, named for a human rather than for the schema. */
export const EVIDENCE_PLAIN: Record<EvidenceRef['kind'], string> = {
  calibration: 'History here',
  playbook: 'Standing rule',
  precedent: 'Similar case',
  responder: 'Responder',
  correlation: 'Related alarms',
  policy: 'Site facts',
};

/** Which way a piece of evidence pushed, in words rather than a sign. */
export function evidenceDirection(weight: number): string {
  return weight >= 0 ? 'argued for responding' : 'argued for standing down';
}

// ── Outcomes ────────────────────────────────────────────────────────────────

/** What actually happened, once ground truth is revealed. */
export const OUTCOME_PLAIN: Record<ResolutionOutcome, string> = {
  true_positive: 'Real, and handled',
  false_alarm: 'Turned out to be nothing',
  missed: 'Real, and missed',
  declined: 'Responder declined',
  unresolved: 'Still open',
};

/**
 * Was the call right? A false alarm the agent stood down on is a *win*, not a
 * failure, grading purely on `outcome` would score restraint as an error.
 */
export function wasRight(inc: Incident): boolean {
  const acted = inc.decision?.action === 'dispatch' || inc.decision?.action === 'escalate';
  return inc.outcome === 'true_positive' || (inc.outcome === 'false_alarm' && !acted);
}
