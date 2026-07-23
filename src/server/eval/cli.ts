/**
 * npm run eval -- --seed 42 --events 400 [--llm] [--assert]
 * npm run eval -- --seeds 20 --events 400 [--assert]
 *
 * Runs the A/B replay outside the console for CI. `--seeds N` runs the
 * multi-world experiment instead and reports a confidence interval.
 */

import 'dotenv/config';
import type { EvalArm, Experiment, Metrics } from '../../shared/types';
import { LOWER_IS_BETTER } from './metrics';
import { runEval } from './harness';
import { runExperiment } from './experiment';

const DIM = '\x1b[2m';
const B = '\x1b[1m';
const R = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const ORANGE = '\x1b[38;5;202m';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const ROWS: Array<{ key: keyof Metrics; label: string; pct: boolean }> = [
  { key: 'falseDispatchRate', label: 'False dispatch rate', pct: true },
  { key: 'missedCriticalRate', label: 'Missed critical rate', pct: true },
  { key: 'truePositiveActionRate', label: 'True-positive action rate', pct: true },
  { key: 'operatorAgreementRate', label: 'Oracle agreement', pct: true },
  { key: 'responderAcceptRate', label: 'Responder accept rate', pct: true },
  { key: 'medianDecisionLatencyMs', label: 'Median decision latency', pct: false },
  { key: 'dispatchScore', label: 'DISPATCH SCORE', pct: false },
];

function fmt(v: number, pct: boolean, key: keyof Metrics): string {
  if (key === 'medianDecisionLatencyMs') return `${Math.round(v)}ms`;
  if (key === 'dispatchScore') return v.toFixed(1);
  return pct ? `${(v * 100).toFixed(1)}%` : v.toFixed(2);
}

function pad(s: string, n: number): string {
  const bare = s.replace(/\x1b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, n - bare.length));
}

/** Multi-world mode: the claim with error bars on it. */
async function runExperimentMode(baseSeed: number, events: number, useLlm: boolean): Promise<void> {
  const seedCount = arg('seeds', 20);

  console.log(`\n${B}guard[ai]n${R} ${ORANGE}■${R}  multi-world learning experiment`);
  console.log('─'.repeat(76));
  console.log(`${DIM}base seed ${baseSeed} · ${seedCount} worlds · ${events} events each · judgment: ${useLlm ? 'hosted model' : 'Reasoner (deterministic)'}${R}\n`);

  const exp = await runExperiment({
    baseSeed,
    seedCount,
    eventCount: events,
    useLlm,
    onProgress: (done, total, latest) => {
      const bar = `${'█'.repeat(done)}${'·'.repeat(Math.max(0, total - done))}`;
      const sign = latest.liftPoints >= 0 ? '+' : '';
      const tone = latest.liftPoints > 0 ? GREEN : latest.liftPoints < 0 ? RED : DIM;
      process.stdout.write(
        `\r${DIM}${bar}${R} ${done}/${total}  seed ${String(latest.seed).padEnd(7)} ` +
        `${tone}${sign}${latest.liftPoints.toFixed(1)}${R}   `,
      );
    },
  });
  process.stdout.write('\r'.padEnd(78) + '\r');

  printExperiment(exp);

  if (process.argv.includes('--assert')) {
    if (!exp.summary.significant) {
      console.error(
        `${RED}${B}ASSERTION FAILED${R}, the 95% interval [${exp.summary.ciLowPoints.toFixed(2)}, ` +
        `${exp.summary.ciHighPoints.toFixed(2)}] includes zero, so this run does not establish that learning helps.\n`,
      );
      process.exit(1);
    }
  }
}

function printExperiment(exp: Experiment): void {
  const s = exp.summary;
  const w = 76;

  console.log(`${B}PER WORLD${R}  ${DIM}learned - static, in points of dispatch score${R}`);
  // A text strip chart: every seed visible, so nobody has to trust the mean.
  const max = Math.max(...exp.seeds.map((r) => Math.abs(r.liftPoints)), 1);
  for (const r of exp.seeds) {
    const n = Math.round((Math.abs(r.liftPoints) / max) * 34);
    const bar = r.liftPoints >= 0
      ? `${' '.repeat(34)}│${GREEN}${'█'.repeat(n)}${R}`
      : `${' '.repeat(34 - n)}${RED}${'█'.repeat(n)}${R}│`;
    const sign = r.liftPoints >= 0 ? '+' : '';
    console.log(
      `  ${DIM}${String(r.seed).padEnd(8)}${R}${bar}  ${sign}${r.liftPoints.toFixed(1)}` +
      `  ${DIM}(${r.staticScore.toFixed(1)} → ${r.learnedScore.toFixed(1)})${R}`,
    );
  }

  console.log(`\n${'─'.repeat(w)}`);
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  console.log(`${B}RESULT${R}`);
  console.log(`  ${pad('Worlds where learning won', 34)}${B}${s.wins}/${exp.seeds.length}${R}  ${DIM}(${pct(s.winRate)})${R}`);
  console.log(`  ${pad('Mean lift', 34)}${B}${s.meanLiftPoints >= 0 ? '+' : ''}${s.meanLiftPoints.toFixed(2)}${R} points  ${DIM}(${s.meanLiftPct >= 0 ? '+' : ''}${s.meanLiftPct.toFixed(1)}%)${R}`);
  console.log(`  ${pad('95% confidence interval', 34)}[${s.ciLowPoints.toFixed(2)}, ${s.ciHighPoints.toFixed(2)}]  ${DIM}sd ${s.sdLiftPoints.toFixed(2)}${R}`);
  console.log(`  ${pad('Of which prior experience', 34)}${s.meanPriorExperiencePoints >= 0 ? '+' : ''}${s.meanPriorExperiencePoints.toFixed(2)} points  ${DIM}(learned - cold)${R}`);

  const verdict = s.significant
    ? `${GREEN}${B}LEARNING HELPS${R}: the whole 95% interval sits above zero.`
    : `${ORANGE}${B}NOT ESTABLISHED${R}: the interval includes zero. Run more worlds, or the effect is not there.`;
  console.log(`\n  ${verdict}`);
  console.log(`  ${DIM}completed in ${(exp.durationMs / 1000).toFixed(1)}s${R}\n`);

  console.log(`${B}METHODOLOGY${R}`);
  for (const line of exp.notes.split('\n')) console.log(`  ${DIM}${line}${R}`);
  console.log('');
}

async function main(): Promise<void> {
  const seed = arg('seed', Number(process.env.SENTRY_SEED ?? 20260721));
  const events = arg('events', 400);
  const useLlm = process.argv.includes('--llm');

  if (process.argv.includes('--seeds')) {
    await runExperimentMode(seed, events, useLlm);
    return;
  }

  console.log(`\n${B}guard[ai]n${R} ${ORANGE}■${R}  A/B replay evaluation`);
  console.log('─'.repeat(76));
  console.log(`${DIM}seed ${seed} · ${events} events · judgment: ${useLlm ? 'hosted model' : 'Reasoner (deterministic)'}${R}\n`);

  const t0 = Date.now();
  const run = await runEval({ seed, eventCount: events, useLlm });
  const by = (id: string): EvalArm | undefined => run.arms.find((a) => a.id === id);

  const cols = ['static', 'cold', 'learned'];
  console.log(pad(`${B}METRIC${R}`, 34) + cols.map((c) => pad(c.toUpperCase(), 13)).join('') + `${B}Δ vs static${R}`);
  console.log('─'.repeat(76));

  for (const row of ROWS) {
    const vals = cols.map((c) => by(c)?.metrics[row.key] ?? 0);
    const [base, , learned] = vals as [number, number, number];
    const delta = learned - base;
    const lower = LOWER_IS_BETTER.has(row.key);
    const better = lower ? delta < 0 : delta > 0;
    const flat = Math.abs(delta) < 1e-9;

    const arrow = flat ? `${DIM}-${R}` : `${better ? GREEN : RED}${delta > 0 ? '▲' : '▼'} ${fmt(Math.abs(delta), row.pct, row.key)}${R}`;
    const emphasis = row.key === 'dispatchScore' ? B : '';

    console.log(
      pad(`${emphasis}${row.label}${R}`, 34) +
      vals.map((v) => pad(`${emphasis}${fmt(v, row.pct, row.key)}${R}`, 13)).join('') +
      arrow,
    );
  }

  console.log('─'.repeat(76));

  const s = by('static')?.metrics.dispatchScore ?? 0;
  const l = by('learned')?.metrics.dispatchScore ?? 0;
  const lift = s > 0 ? ((l - s) / s) * 100 : 0;
  const verdict = l > s
    ? `${GREEN}${B}LEARNED ARM WINS${R}, dispatch score ${s.toFixed(1)} → ${l.toFixed(1)} (${lift >= 0 ? '+' : ''}${lift.toFixed(1)}%)`
    : l === s
      ? `${DIM}NO MEASURABLE DIFFERENCE at this event count${R}`
      : `${RED}${B}LEARNED ARM LOST${R}, ${s.toFixed(1)} → ${l.toFixed(1)}. Worth investigating.`;
  console.log(`\n  ${verdict}`);
  console.log(`  ${DIM}completed in ${((Date.now() - t0) / 1000).toFixed(1)}s${R}\n`);

  console.log(`${B}METHODOLOGY${R}`);
  for (const line of run.notes.split('\n')) console.log(`  ${DIM}${line}${R}`);
  console.log('');

  // `--assert` turns the run into a regression gate. Off by default, because a
  // single seed is a data point and exiting non-zero on one would encourage
  // seed-shopping; on, it is what `npm run verify` uses across several seeds.
  if (process.argv.includes('--assert') && l <= s) {
    console.error(`${RED}${B}ASSERTION FAILED${R}, learned (${l.toFixed(1)}) did not beat static (${s.toFixed(1)}).\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nEval failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
