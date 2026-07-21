/**
 * CHANNEL B — the responder model, as a contextual bandit.
 *
 * Per responder we keep Beta posteriors on P(accept) and P(resolves correctly)
 * plus Welford running stats on response time. Ranking blends those with the
 * incident context (ETA, required skill). With `explore` on we Thompson-sample
 * the two Beta posteriors instead of using their means, which is what lets the
 * roster view honestly distinguish exploring from exploiting.
 *
 * None of the `truth` fields on Guard/Robot are read here. Everything in this
 * file is learned from revealed outcomes.
 */

import type {
  Responder, ResponderCandidate, ResponderModel, SimTime, Skill,
} from '../../shared/types';
import { inHourRange, simHourOf } from '../../shared/types';
import type { ResponderStore, WorldState } from '../contracts';

/** Structural shape of `util/rng`'s Rng — injected so evals can be reproducible. */
export interface RandomSource {
  next(): number;
}

/** Mildly optimistic priors: unknown responders look worth trying. */
const ACCEPT_ALPHA0 = 2;
const ACCEPT_BETA0 = 1;
const RESOLVE_ALPHA0 = 2;
const RESOLVE_BETA0 = 1;

/** Below this many dispatches the model is still exploring. */
const EXPLORE_UNTIL = 5;

/** Response time at which the speed term bottoms out (15 sim-minutes). */
const SLOW_MS = 15 * 60 * 1000;
/** ETA at which the proximity term bottoms out. */
const FAR_ETA_MS = 15 * 60 * 1000;

// Utility weights. Sum to 1 so `sampledUtility` stays in 0..1 and is comparable
// across incidents. Skill carries the largest single weight: an unqualified
// responder has to win everything else outright to beat a qualified one.
const W_ETA = 0.30;
const W_SKILL = 0.28;
const W_ACCEPT = 0.24;
const W_RESOLVE = 0.18;

const SKILL_LABEL: Record<Skill, string> = {
  armed: 'armed',
  medical: 'medical',
  fire: 'fire-response',
  access_control: 'access-control',
  k9: 'K9',
  de_escalation: 'de-escalation',
  technical: 'technical',
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function fmtDur(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function skillsOf(r: Responder): Skill[] {
  return r.kind === 'guard' ? r.skills : [];
}

// ── Thompson sampling primitives ────────────────────────────────────────────
// Beta(a,b) via two Marsaglia-Tsang Gammas. Stochastic by design; pass an Rng
// through the constructor when a run needs to be reproducible.

function gaussian(rnd: () => number): number {
  const u = Math.max(rnd(), Number.MIN_VALUE);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleGamma(shape: number, rnd: () => number): number {
  if (shape <= 0) return 0;
  if (shape < 1) {
    const u = Math.max(rnd(), 1e-12);
    return sampleGamma(shape + 1, rnd) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 256; i++) {
    let x = 0;
    let v = 0;
    do {
      x = gaussian(rnd);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rnd();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(u, 1e-300)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d; // pathological rnd; fall back to the mode rather than spin
}

function sampleBeta(alpha: number, beta: number, rnd: () => number): number {
  const x = sampleGamma(alpha, rnd);
  const y = sampleGamma(beta, rnd);
  const sum = x + y;
  return sum > 0 ? clamp01(x / sum) : alpha / (alpha + beta);
}

// ── Store ───────────────────────────────────────────────────────────────────

export class Responders implements ResponderStore {
  private models_ = new Map<string, ResponderModel>();
  private rnd: () => number;

  constructor(private world: WorldState, rng?: RandomSource) {
    this.rnd = rng ? () => rng.next() : () => Math.random();
    this.seedRoster();
  }

  /**
   * `now` is optional because ResponderStore does not carry a clock; when the
   * caller supplies it we also enforce guard shift windows rather than
   * trusting the simulator to have flipped `status` to off_shift already.
   */
  rank(
    candidates: Array<{ responder: Responder; etaMs: number; skillMatch: boolean }>,
    opts: { explore: boolean; requiredSkill: Skill | null },
    now?: SimTime,
  ): ResponderCandidate[] {
    const hour = now === undefined ? null : simHourOf(now);

    const eligible = candidates.filter(({ responder }) => {
      if (responder.status !== 'available') return false;
      if (hour !== null && responder.kind === 'guard' && !inHourRange(hour, responder.shift)) return false;
      return true;
    });
    if (eligible.length === 0) return [];

    const scored = eligible.map(({ responder, etaMs, skillMatch }) => {
      const model = this.ensure(responder.id);
      const skills = skillsOf(responder);
      // Trust our own view of the roster over the caller's flag.
      const matched = opts.requiredSkill ? skills.includes(opts.requiredSkill) : skillMatch;

      const pAccept = opts.explore
        ? sampleBeta(model.acceptAlpha, model.acceptBeta, this.rnd)
        : model.pAccept;
      const pResolve = opts.explore
        ? sampleBeta(model.resolveAlpha, model.resolveBeta, this.rnd)
        : model.pResolve;

      const etaScore = clamp01(1 - etaMs / FAR_ETA_MS);
      // No skill requirement => neutral 0.5 so the term neither rewards nor punishes.
      const skillScore = opts.requiredSkill ? (matched ? 1 : 0) : 0.5;

      const utility =
        W_ETA * etaScore + W_SKILL * skillScore + W_ACCEPT * pAccept + W_RESOLVE * pResolve;

      return {
        responder,
        etaMs,
        matched,
        model,
        pAccept,
        pResolve,
        utility: round4(clamp01(utility)),
      };
    });

    scored.sort((a, b) => {
      if (b.utility !== a.utility) return b.utility - a.utility;
      if (a.etaMs !== b.etaMs) return a.etaMs - b.etaMs;
      return a.responder.id < b.responder.id ? -1 : 1;
    });

    const bestEta = Math.min(...scored.map((s) => s.etaMs));

    return scored.map((s) => ({
      responderId: s.responder.id,
      name: s.responder.name,
      status: s.responder.status,
      skills: skillsOf(s.responder),
      etaMs: s.etaMs,
      skillMatch: s.matched,
      model: { ...s.model },
      sampledUtility: s.utility,
      reason: this.explain({
        model: s.model,
        etaMs: s.etaMs,
        isClosest: s.etaMs === bestEta,
        matched: s.matched,
        requiredSkill: opts.requiredSkill,
        explore: opts.explore,
        pAccept: s.pAccept,
        isRobot: s.responder.kind === 'robot',
      }),
    }));
  }

  observeOffer(responderId: string, accepted: boolean): void {
    const m = this.ensure(responderId);
    if (accepted) m.acceptAlpha += 1;
    else m.acceptBeta += 1;
    m.dispatches += 1;
    this.refresh(m);
  }

  observeArrival(responderId: string, responseMs: number): void {
    if (!Number.isFinite(responseMs) || responseMs < 0) return;
    const m = this.ensure(responderId);
    m.responseCount += 1;
    const delta = responseMs - m.responseMeanMs;
    m.responseMeanMs += delta / m.responseCount;
    m.responseM2 += delta * (responseMs - m.responseMeanMs);
    this.refresh(m);
  }

  observeResolution(responderId: string, resolvedCorrectly: boolean): void {
    const m = this.ensure(responderId);
    if (resolvedCorrectly) m.resolveAlpha += 1;
    else m.resolveBeta += 1;
    this.refresh(m);
  }

  models(): ResponderModel[] {
    return [...this.models_.values()]
      .map((m) => ({ ...m }))
      .sort((a, b) => (b.score - a.score) || (a.responderId < b.responderId ? -1 : 1));
  }

  get(responderId: string): ResponderModel {
    return { ...this.ensure(responderId) };
  }

  reset(): void {
    this.models_.clear();
    this.seedRoster();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Pre-create a model per responder so the roster view is populated at t=0. */
  private seedRoster(): void {
    for (const g of this.world.guards) this.ensure(g.id, g.name);
    for (const r of this.world.robots) this.ensure(r.id, r.name);
  }

  private ensure(responderId: string, name?: string): ResponderModel {
    let m = this.models_.get(responderId);
    if (!m) {
      m = {
        responderId,
        name: name ?? this.world.responderById.get(responderId)?.name ?? responderId,
        acceptAlpha: ACCEPT_ALPHA0,
        acceptBeta: ACCEPT_BETA0,
        pAccept: 0,
        responseCount: 0,
        responseMeanMs: 0,
        responseM2: 0,
        responseStdMs: 0,
        resolveAlpha: RESOLVE_ALPHA0,
        resolveBeta: RESOLVE_BETA0,
        pResolve: 0,
        dispatches: 0,
        score: 0,
        exploring: true,
      };
      this.refresh(m);
      this.models_.set(responderId, m);
    }
    return m;
  }

  private refresh(m: ResponderModel): void {
    m.pAccept = round4(m.acceptAlpha / (m.acceptAlpha + m.acceptBeta));
    m.pResolve = round4(m.resolveAlpha / (m.resolveAlpha + m.resolveBeta));
    m.responseStdMs =
      m.responseCount > 1 ? Math.round(Math.sqrt(m.responseM2 / (m.responseCount - 1))) : 0;
    m.exploring = m.dispatches < EXPLORE_UNTIL;

    const speed = m.responseCount === 0 ? 0.5 : clamp01(1 - m.responseMeanMs / SLOW_MS);
    // Consistency: 1 - coefficient of variation. Unproven responders sit neutral.
    const consistency =
      m.responseCount < 2 || m.responseMeanMs <= 0
        ? 0.5
        : clamp01(1 - m.responseStdMs / m.responseMeanMs);

    m.score = round4(
      clamp01(0.32 * m.pAccept + 0.28 * m.pResolve + 0.28 * speed + 0.12 * consistency),
    );
  }

  private explain(args: {
    model: ResponderModel;
    etaMs: number;
    isClosest: boolean;
    matched: boolean;
    requiredSkill: Skill | null;
    explore: boolean;
    pAccept: number;
    isRobot: boolean;
  }): string {
    const { model, etaMs, isClosest, matched, requiredSkill, explore, pAccept, isRobot } = args;
    const parts: string[] = [];

    // This string is read by a shift supervisor inside the decision rationale,
    // so it says what the sampler did in words. The posterior itself is still
    // on the Roster screen for anyone who wants the arithmetic.
    if (explore && model.exploring) {
      parts.push(
        `chosen with only ${model.dispatches} previous dispatch${model.dispatches === 1 ? '' : 'es'} on record — ` +
        `Sentry gives under-used responders a turn rather than always sending the same person ` +
        `(${pct(pAccept)} chance of accepting)`,
      );
      parts.push(`ETA ${fmtDur(etaMs)}`);
    } else {
      parts.push(`${isClosest ? 'closest available' : 'available'} (ETA ${fmtDur(etaMs)})`);
      parts.push(
        model.dispatches >= 3
          ? `accepts ${pct(model.pAccept)} of calls`
          : `too few calls so far to know their accept rate (${model.dispatches})`,
      );
    }

    if (model.responseCount >= 2) {
      parts.push(`usually on scene in ${fmtDur(model.responseMeanMs)}`);
    }
    if (model.dispatches >= 4) {
      parts.push(`resolves ${pct(model.pResolve)} of calls cleanly`);
    }
    if (requiredSkill) {
      parts.push(matched
        ? `trained for ${SKILL_LABEL[requiredSkill]}`
        : `not trained for ${SKILL_LABEL[requiredSkill]}`);
    }
    if (isRobot) parts.push('robot — can observe, cannot intervene');

    return parts.join(', ');
  }
}
