/**
 * npm run eval -- --seed 42 --events 400 [--claude]
 *
 * Runs the A/B replay outside the console so the result can be checked in CI or
 * pasted into a review without trusting a screenshot.
 */

import 'dotenv/config';
import type { EvalArm, Metrics } from '../../shared/types';
import { LOWER_IS_BETTER } from './metrics';
import { runEval } from './harness';

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

async function main(): Promise<void> {
  const seed = arg('seed', Number(process.env.SENTRY_SEED ?? 20260721));
  const events = arg('events', 400);
  const useClaude = process.argv.includes('--claude');

  console.log(`\n${B}SENTRY${R} ${ORANGE}■${R}  A/B replay evaluation`);
  console.log('─'.repeat(76));
  console.log(`${DIM}seed ${seed} · ${events} events · judgment: ${useClaude ? 'Claude' : 'Reasoner (deterministic)'}${R}\n`);

  const t0 = Date.now();
  const run = await runEval({ seed, eventCount: events, useClaude });
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

    const arrow = flat ? `${DIM}—${R}` : `${better ? GREEN : RED}${delta > 0 ? '▲' : '▼'} ${fmt(Math.abs(delta), row.pct, row.key)}${R}`;
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
    ? `${GREEN}${B}LEARNED ARM WINS${R} — dispatch score ${s.toFixed(1)} → ${l.toFixed(1)} (${lift >= 0 ? '+' : ''}${lift.toFixed(1)}%)`
    : l === s
      ? `${DIM}NO MEASURABLE DIFFERENCE at this event count${R}`
      : `${RED}${B}LEARNED ARM LOST${R} — ${s.toFixed(1)} → ${l.toFixed(1)}. Worth investigating.`;
  console.log(`\n  ${verdict}`);
  console.log(`  ${DIM}completed in ${((Date.now() - t0) / 1000).toFixed(1)}s${R}\n`);

  console.log(`${B}METHODOLOGY${R}`);
  for (const line of run.notes.split('\n')) console.log(`  ${DIM}${line}${R}`);
  console.log('');

  // `--assert` turns the run into a regression gate. Off by default, because a
  // single seed is a data point and exiting non-zero on one would encourage
  // seed-shopping; on, it is what `npm run verify` uses across several seeds.
  if (process.argv.includes('--assert') && l <= s) {
    console.error(`${RED}${B}ASSERTION FAILED${R} — learned (${l.toFixed(1)}) did not beat static (${s.toFixed(1)}).\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nEval failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
