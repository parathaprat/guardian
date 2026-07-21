/**
 * SENTRY: the learning claim as an experiment rather than an anecdote.
 *
 * `runEval` replays one seeded stream through three arms and reports a lift.
 * That answers "did the learned arm win on this world?" It does not answer the
 * only question that matters commercially, which is "does it win in general, or
 * did you pick a good seed?"
 *
 * Online learning makes every run order-dependent, so single-seed lift is a
 * random variable. This runs the same protocol across many independently seeded
 * worlds and reports the distribution: how often learning wins, by how much on
 * average, and how wide the interval around that average is. A 95% interval that
 * straddles zero means the result is noise, and this will say so rather than
 * quoting the best of three.
 *
 * Nothing here re-implements the eval. It is `runEval` in a loop plus honest
 * arithmetic, which is deliberate: the thing under test stays the thing that
 * ships.
 */

import type { EvalRun, Experiment, ExperimentSummary, Metrics, SeedResult } from '../../shared/types';
import { runEval } from './harness';
import type { RunEvalOptions } from './harness';

/** Seeds are derived, not random, so an experiment is itself reproducible. */
export function seedsFor(baseSeed: number, count: number): number[] {
  const out: number[] = [];
  // A cheap odd-multiplier walk. Distinct, deterministic, and unrelated to the
  // world generator's own stream, so no seed can be accidentally privileged.
  let s = baseSeed >>> 0;
  for (let i = 0; i < count; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out.push(s % 1_000_000);
  }
  return out;
}

/**
 * Student's t critical value at 95%, two-tailed, by degrees of freedom.
 *
 * Hardcoded rather than approximated with 1.96: at the sample sizes an operator
 * will actually run (10 to 30 seeds) the normal approximation understates the
 * interval by enough to matter, and understating your own error bars is the
 * exact failure this file exists to prevent.
 */
const T95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145,
  15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
  21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056,
  27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
};

function tCritical(df: number): number {
  if (df < 1) return Number.POSITIVE_INFINITY;
  if (df <= 30) return T95[df] ?? 2.042;
  if (df <= 40) return 2.021;
  if (df <= 60) return 2.000;
  if (df <= 120) return 1.980;
  return 1.960;
}

function scoreOf(run: EvalRun, arm: 'static' | 'cold' | 'learned'): number {
  return run.arms.find((a) => a.id === arm)?.metrics.dispatchScore ?? 0;
}

function metricOf(run: EvalRun, arm: 'static' | 'learned', key: keyof Metrics): number {
  const v = run.arms.find((a) => a.id === arm)?.metrics[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export interface ExperimentOptions extends Omit<RunEvalOptions, 'seed'> {
  baseSeed: number;
  seedCount: number;
  /** Called after each seed so a long run can report progress. */
  onProgress?: (done: number, total: number, latest: SeedResult) => void;
}

export async function runExperiment(opts: ExperimentOptions): Promise<Experiment> {
  const startedAt = Date.now();
  const seeds = seedsFor(opts.baseSeed, Math.max(2, Math.min(60, opts.seedCount)));
  const results: SeedResult[] = [];
  let engine: 'claude' | 'reasoner' = 'reasoner';

  for (const seed of seeds) {
    const run = await runEval({
      seed,
      eventCount: opts.eventCount,
      useClaude: opts.useClaude,
      ...(opts.liveMemory ? { liveMemory: opts.liveMemory } : {}),
    });
    engine = run.engine;

    const staticScore = scoreOf(run, 'static');
    const coldScore = scoreOf(run, 'cold');
    const learnedScore = scoreOf(run, 'learned');
    const result: SeedResult = {
      seed,
      staticScore,
      coldScore,
      learnedScore,
      liftPoints: learnedScore - staticScore,
      liftPct: staticScore > 0 ? ((learnedScore - staticScore) / staticScore) * 100 : 0,
      priorExperiencePoints: learnedScore - coldScore,
      missedCriticalStatic: metricOf(run, 'static', 'missedCriticalRate'),
      missedCriticalLearned: metricOf(run, 'learned', 'missedCriticalRate'),
      falseDispatchStatic: metricOf(run, 'static', 'falseDispatchRate'),
      falseDispatchLearned: metricOf(run, 'learned', 'falseDispatchRate'),
    };
    results.push(result);
    opts.onProgress?.(results.length, seeds.length, result);
  }

  return {
    id: `EXP-${startedAt.toString(36).toUpperCase()}`,
    createdAt: startedAt,
    baseSeed: opts.baseSeed,
    eventCount: opts.eventCount,
    engine,
    seeds: results,
    summary: summarise(results),
    durationMs: Date.now() - startedAt,
    notes: buildNotes(results.length, opts.eventCount, engine),
  };
}

export function summarise(results: SeedResult[]): ExperimentSummary {
  const n = results.length;
  const lifts = results.map((r) => r.liftPoints);
  const mean = n > 0 ? lifts.reduce((a, b) => a + b, 0) / n : 0;

  // Sample variance (n−1). With n−0 the interval would be too narrow, which is
  // the same sin as quoting the best seed, just better disguised.
  const variance = n > 1
    ? lifts.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1)
    : 0;
  const sd = Math.sqrt(variance);
  const stderr = n > 0 ? sd / Math.sqrt(n) : 0;
  const ci = tCritical(n - 1) * stderr;

  const wins = results.filter((r) => r.liftPoints > 0).length;
  const losses = results.filter((r) => r.liftPoints < 0).length;

  const meanPct = n > 0 ? results.reduce((a, r) => a + r.liftPct, 0) / n : 0;
  const meanPrior = n > 0 ? results.reduce((a, r) => a + r.priorExperiencePoints, 0) / n : 0;

  return {
    winRate: n > 0 ? wins / n : 0,
    wins,
    losses,
    ties: n - wins - losses,
    meanLiftPoints: mean,
    sdLiftPoints: sd,
    ci95Points: ci,
    ciLowPoints: mean - ci,
    ciHighPoints: mean + ci,
    meanLiftPct: meanPct,
    meanPriorExperiencePoints: meanPrior,
    significant: Number.isFinite(ci) && mean - ci > 0,
  };
}

function buildNotes(seedCount: number, eventCount: number, engine: string): string {
  return [
    `${seedCount} independently seeded worlds, ${eventCount} scored events each, judged by the ${engine} engine.`,
    'Each world runs the standard protocol: one event stream generated once and replayed verbatim through all three arms, every arm rebuilt from the same seed, learning applied online and strictly after each decision is committed.',
    'The reported interval is a 95% confidence interval on the mean lift across worlds, using the t distribution with n−1 degrees of freedom. It describes variation between worlds, not measurement error within one.',
    'Seeds are derived deterministically from the base seed, so the whole experiment reproduces exactly. No seed is selected after seeing its result.',
    'This remains a claim about a simulated world whose regularities were authored here. It establishes that the learning loop closes and by how much, not that the same margin would appear on a real portfolio.',
  ].join('\n');
}
