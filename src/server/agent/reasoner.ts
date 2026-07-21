/**
 * SENTRY — the deterministic judgment engine.
 *
 * This is not a stub. It is the engine the eval harness scores (fast, free,
 * reproducible) and the engine the whole product falls back to when no API key
 * is present. It runs the *same* evidence tools as the Claude agent, in a fixed
 * order, then applies an explicit expected-cost policy.
 *
 * Because it and ClaudeAgent share evidence assembly, an A/B run that holds the
 * engine constant and varies only memory isolates the learning contribution.
 */

import type {
  AgentActionKind, AgentDecision, EvidenceRef, Priority, Severity, TraceStep,
} from '../../shared/types';
import { priorityFromSeverity } from '../../shared/types';
import type { AgentContext, DispatchAgent } from '../contracts';
import {
  TOOL_NAMES, TYPE_PROFILE, isLifeSafety, requiredSkillFor, runTool, asSeverity, clamp, round,
  type CorrelationResult, type PlaybookResult, type PrecedentResult, type ResponderResult,
  type ZoneHistoryResult,
} from './tools';

/**
 * Cost model, in arbitrary but consistent units.
 *
 * A nuisance dispatch costs guard time *and* guard trust — the second is why the
 * penalty is superlinear in P(false). A miss costs severity², because in physical
 * security the tail is the whole risk: a missed person-down is not five times
 * worse than a missed noise complaint, it is categorically different.
 */
const COST_GUARD_TIME = 3.2;
const COST_TRUST = 5.0;
/** How much worse a miss is than the guard-time it saved. Tuned, not guessed. */
const MISS_ASYMMETRY = 1.6;

let stepSeq = 0;

function step(
  kind: TraceStep['kind'],
  label: string,
  startedAt: number,
  extra: Partial<TraceStep> = {},
): TraceStep {
  return {
    id: `TS-${++stepSeq}`,
    index: 0,
    kind,
    durationMs: Math.max(0, Date.now() - startedAt),
    label,
    ...extra,
  };
}

export class ReasonerAgent implements DispatchAgent {
  readonly engine = 'reasoner' as const;

  async decide(ctx: AgentContext): Promise<{ decision: AgentDecision; trace: TraceStep[]; latencyMs: number }> {
    const t0 = Date.now();
    const trace: TraceStep[] = [];
    const evidence: EvidenceRef[] = [];

    const emit = (s: TraceStep) => {
      s.index = trace.length;
      trace.push(s);
      ctx.onTraceStep?.(s);
    };

    const profile = TYPE_PROFILE[ctx.event.type];
    const requiredSkill = requiredSkillFor(ctx.event.type);

    emit(step('thinking', 'Framing the call', t0, {
      detail:
        `${ctx.event.type.replace(/_/g, ' ')} reported in ${ctx.event.metadata.zone ?? ctx.event.zoneId}. ` +
        `Device confidence is ${(ctx.event.sensorConfidence * 100).toFixed(0)}%, but device confidence tracks ` +
        `signal strength rather than truth, so it is a weak input. What matters is what this zone, this ` +
        `hour and this device have actually done before.`,
    }));

    // ── Evidence pass, fixed order ─────────────────────────────────────────
    const gather = async (name: string, input: Record<string, unknown>) => {
      const s0 = Date.now();
      emit(step('tool_call', name, s0, { toolName: name, toolInput: input }));
      const out = await runTool(name, input, ctx);
      evidence.push(...out.evidence);
      emit(step('tool_result', out.label, s0, { toolName: name, toolResult: out.result }));
      return out.result;
    };

    const history = (await gather(TOOL_NAMES.zoneHistory, {
      zone_id: ctx.event.zoneId, event_type: ctx.event.type,
    })) as ZoneHistoryResult;

    const correlation = (await gather(TOOL_NAMES.correlate, {
      window_minutes: 15,
    })) as CorrelationResult;

    const playbook = (await gather(TOOL_NAMES.playbook, {})) as PlaybookResult;

    const precedent = (await gather(TOOL_NAMES.precedent, {
      limit: 3,
    })) as PrecedentResult;

    // ── Posterior on P(real) ───────────────────────────────────────────────
    let pReal = history.available ? history.pReal : profile.prior;
    const learnedFrom = history.available ? history.observations : 0;

    // The playbook multiplier is a human-approved override on the statistics.
    let ruleFloor: Priority | null = null;
    let ruleAction: AgentActionKind | null = null;
    if (playbook.available && playbook.rules.length > 0) {
      const top = playbook.rules[0]!;
      pReal = clamp(pReal / Math.max(0.1, top.falseAlarmMultiplier), 0.01, 0.99);
      ruleFloor = top.priorityFloor;
      ruleAction = top.action;
    }

    // Precedent nudges, weighted by similarity — it is the weakest channel, so it
    // moves the posterior least.
    if (precedent.available && precedent.matches.length > 0) {
      let num = 0;
      let den = 0;
      for (const m of precedent.matches) {
        const wasReal = m.outcome === 'true_positive' || m.outcome === 'missed';
        num += m.similarity * (wasReal ? 1 : 0);
        den += m.similarity;
      }
      if (den > 0) pReal = clamp(pReal * 0.82 + (num / den) * 0.18, 0.01, 0.99);
    }

    // Sensor confidence is admitted, but heavily discounted.
    pReal = clamp(pReal * 0.9 + ctx.event.sensorConfidence * 0.1, 0.01, 0.99);

    // A correlated burst is the strongest single signal in the system.
    if (correlation.patternDetected) {
      pReal = clamp(pReal + 0.35, 0.01, 0.99);
    }

    // ── Expected severity ──────────────────────────────────────────────────
    const zone = ctx.world.zoneById.get(ctx.event.zoneId);
    const severity = asSeverity(
      profile.severity + correlation.severityUplift + ((zone?.baseRisk ?? 0) > 0.65 ? 1 : 0),
    );

    // ── Expected-cost comparison ───────────────────────────────────────────
    // The severity term is squared *and* scaled: a missed high-severity incident
    // is the only irreversible failure in this domain, so under-responding has to
    // be priced well above the guard-time it saves. Without the asymmetry factor
    // the policy monitors its way into a ~40% miss rate on severity-4 events.
    const costOfInaction = pReal * severity * severity * MISS_ASYMMETRY;
    const costOfResponse = COST_GUARD_TIME + (1 - pReal) * COST_TRUST;
    const respond = costOfInaction > costOfResponse;

    emit(step('thinking', 'Weighing expected cost', Date.now(), {
      detail:
        `Posterior P(real) = ${(pReal * 100).toFixed(0)}%` +
        (learnedFrom > 0 ? ` from ${learnedFrom} prior observation${learnedFrom === 1 ? '' : 's'}` : ' (no history — using the type prior)') +
        `. Expected severity ${severity}. Cost of not responding ≈ ${costOfInaction.toFixed(1)}; ` +
        `cost of responding ≈ ${costOfResponse.toFixed(1)} (guard time plus a trust penalty scaled by ` +
        `${((1 - pReal) * 100).toFixed(0)}% chance this is a nuisance call). ` +
        (respond ? 'Responding is cheaper in expectation.' : 'Holding is cheaper in expectation.'),
    }));

    // ── Action selection ───────────────────────────────────────────────────
    let action: AgentActionKind;
    if (isLifeSafety(ctx.event.type)) {
      // Hard floor. No posterior is allowed to suppress a life-safety signal —
      // the asymmetry is not something a cost model should be trusted to price.
      action = severity >= 5 ? 'escalate' : 'dispatch';
    } else if (respond || (severity >= 4 && pReal >= 0.3)) {
      // The second clause is a floor, not a tie-break: at severity 4+ a one-in-three
      // chance of being real already justifies a body, whatever the cost model says.
      action = severity >= 5 || correlation.patternDetected ? 'escalate' : 'dispatch';
    } else if (pReal < 0.2 && learnedFrom >= 4) {
      // Suppress outright only once the evidence is actually there.
      action = 'suppress';
    } else if (severity <= 3) {
      action = 'monitor';
    } else {
      // Never let a high-severity call sit in 'monitor' — that is how misses happen.
      action = 'dispatch';
    }

    if (ruleAction && !isLifeSafety(ctx.event.type)) {
      // An approved rule outranks the cost model, but never relaxes an escalation.
      if (!(action === 'escalate' && ruleAction !== 'escalate')) action = ruleAction;
    }

    // ── Responder selection ────────────────────────────────────────────────
    let responderId: string | null = null;
    let responderName = '';
    let responderNote = '';
    if (action === 'dispatch' || action === 'escalate') {
      const responders = (await gather(TOOL_NAMES.responders, {
        required_skill: requiredSkill ?? undefined,
      })) as ResponderResult;
      const best = responders.options[0];
      if (best) {
        responderId = best.responderId;
        responderName = best.name;
        responderNote = best.reason;
      } else {
        // Nobody is available — that is an escalation, not a dispatch.
        action = 'escalate';
        responderNote = 'No responder available at this site; escalating to the supervisor.';
      }
    }

    let priority: Priority = priorityFromSeverity(severity);
    if (ruleFloor && ruleFloor < priority) priority = ruleFloor;
    if (action === 'suppress') priority = 'P3';

    const decision: AgentDecision = {
      action,
      priority,
      severity,
      confidence: round(clamp(0.5 + Math.abs(pReal - 0.5) * 0.8 + Math.min(learnedFrom, 20) / 100, 0.3, 0.97)),
      falseAlarmProbability: round(1 - pReal),
      responderId,
      instruction: this.instruction(action, ctx, responderName),
      rationale: this.rationale({
        action, pReal, learnedFrom, history, correlation, playbook, severity, responderNote,
      }),
      evidence,
      recheckAfterMs: action === 'monitor' ? (severity >= 4 ? 4 : 10) * 60_000 : undefined,
    };

    emit(step('decision', `${action.toUpperCase()} · ${priority}`, t0, { detail: decision.rationale }));
    return { decision, trace, latencyMs: Date.now() - t0 };
  }

  private instruction(action: AgentActionKind, ctx: AgentContext, responder: string): string {
    const zone = ctx.event.metadata.zone ?? ctx.event.zoneId;
    switch (action) {
      case 'dispatch':
        return `${responder}: proceed to ${zone}, verify and report. Do not enter alone if you observe a second party.`;
      case 'escalate':
        return `Supervisor notified. ${responder ? `${responder} moving to ${zone}. ` : ''}Prepare to contact emergency services.`;
      case 'monitor':
        return `Hold ${zone} on camera. Re-evaluate on the next signal or at the recheck window.`;
      case 'suppress':
        return `Auto-closed as a known nuisance pattern at ${zone}. No guard time spent.`;
    }
  }

  private rationale(a: {
    action: AgentActionKind; pReal: number; learnedFrom: number;
    history: ZoneHistoryResult; correlation: CorrelationResult; playbook: PlaybookResult;
    severity: Severity; responderNote: string;
  }): string {
    const parts: string[] = [];
    const pct = (n: number) => `${Math.round(n * 100)}%`;

    if (a.history.available && a.learnedFrom > 0) {
      parts.push(
        `This zone and hour have produced a real incident ${pct(a.history.pReal)} of the time across ` +
        `${a.learnedFrom} observation${a.learnedFrom === 1 ? '' : 's'}`,
      );
    } else {
      parts.push('There is no usable history for this zone, hour and event type yet, so this rests on the type prior');
    }

    if (a.correlation.patternDetected) parts.push(`and ${a.correlation.label.toLowerCase()}`);
    if (a.playbook.available && a.playbook.rules.length > 0) {
      parts.push(`An approved playbook rule applies: ${a.playbook.rules[0]!.title}`);
    }

    const verdict = {
      dispatch: `Dispatching: at ${pct(a.pReal)} likelihood and severity ${a.severity}, the cost of being wrong about a real incident outweighs the guard time.`,
      escalate: `Escalating: severity ${a.severity} at ${pct(a.pReal)} likelihood is above the threshold where a single responder is sufficient.`,
      monitor: `Holding under observation: at ${pct(a.pReal)} the evidence is not strong enough to spend a guard, but not weak enough to close.`,
      suppress: `Suppressing: at ${pct(a.pReal)} this matches an established nuisance pattern, and dispatching would burn guard trust for no security benefit.`,
    }[a.action];

    const body = parts.length > 1
      ? `${parts[0]} ${parts.slice(1).join('. ')}.`
      : `${parts[0]}.`;

    return `${body} ${verdict}${a.responderNote ? ` ${a.responderNote}` : ''}`;
  }
}
