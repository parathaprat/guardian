/**
 * EVALS, the proof.
 *
 * Same seeded event stream, three arms, only the memory varies. The methodology
 * block and the "what this does not prove" note are not decoration: a number a
 * founder is asked to trust should come with its caveats attached.
 */

import { useMemo, useState } from 'react';
import type { EvalArmId, EvalRun, Experiment, Metrics } from '../../../shared/types';
import { GroupedBars, LineChart, MetricTile, type BarGroup } from '../components/charts';
import { EmptyState, Label, Panel, Pill, SegmentedControl, Spinner, Toggle, Tooltip } from '../components/ui';
import { api } from '../lib/api';
import { fmtPct } from '../lib/format';
import { pushToast, useEngine, useLastEval, useLearningCurve } from '../lib/store';
import './views.css';

const ARM_SERIES = [
  { id: 'static', label: 'Static rules' },
  { id: 'cold', label: 'Agent, cold' },
  { id: 'learned', label: 'Agent, learned' },
];

const RATE_ROWS: Array<{ key: keyof Metrics; label: string; lowerIsBetter: boolean }> = [
  { key: 'falseDispatchRate', label: 'False dispatch', lowerIsBetter: true },
  { key: 'missedCriticalRate', label: 'Missed critical', lowerIsBetter: true },
  { key: 'truePositiveActionRate', label: 'True-positive action', lowerIsBetter: false },
  { key: 'operatorAgreementRate', label: 'Oracle agreement', lowerIsBetter: false },
  { key: 'responderAcceptRate', label: 'Responder accept', lowerIsBetter: false },
];

export default function Evals() {
  const run = useLastEval();
  const curve = useLearningCurve();
  const engine = useEngine();

  const [count, setCount] = useState(400);
  const [useClaude, setUseClaude] = useState(false);
  const [busy, setBusy] = useState(false);
  const [onlyDisagree, setOnlyDisagree] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      await api.runEval({ eventCount: count, useClaude });
      pushToast('Evaluation complete.');
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Eval failed', 'error');
    } finally { setBusy(false); }
  };

  return (
    <div className="view scroll">
      <header className="view-head">
        <div>
          <Label>Evaluation</Label>
          <h1 className="display display--l">Prove it<span className="dot-accent" /></h1>
          <p className="view-lede">
            One seeded event stream is generated once and replayed verbatim through three arms.
            The world, the hidden ground truth and the judgment engine are identical in each.
            The only thing that changes is what the agent remembers.
          </p>
        </div>
      </header>

      <section className="view-section">
        <div className="eval-controls">
          <div className="eval-control">
            <Label>Events</Label>
            <SegmentedControl
              value={count}
              onChange={setCount}
              ariaLabel="Event count"
              options={[
                { value: 120, label: '120' },
                { value: 400, label: '400' },
                { value: 900, label: '900' },
              ]}
            />
          </div>
          <div className="eval-control">
            <Tooltip content={engine.engine === 'claude'
              ? 'Runs the judgment layer on Claude. Slower, costs tokens, and non-deterministic, the harness caps it at 120 events.'
              : 'No ANTHROPIC_API_KEY is set, so the Reasoner is the only judgment engine available. The A/B result is still valid: both arms use it.'}
            >
              <Toggle
                checked={useClaude}
                disabled={engine.engine !== 'claude'}
                onChange={setUseClaude}
                label="Use Claude for judgment"
              />
            </Tooltip>
          </div>
          <button type="button" className="btn btn--accent" disabled={busy} onClick={() => void go()}>
            {busy ? <Spinner label="Replaying" /> : 'Run evaluation'}
          </button>
        </div>

        {!run ? (
          <EmptyState title="No run yet" action={
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void go()}>
              Run the first evaluation
            </button>
          }>
            A run generates one event stream from the current seed and pushes it through a static
            rule table, the agent with empty memory, and the agent with trained memory, scoring
            every decision against ground truth the agent never sees.
          </EmptyState>
        ) : <Results run={run} onlyDisagree={onlyDisagree} setOnlyDisagree={setOnlyDisagree} />}
      </section>

      <ExperimentSection />


      <section className="view-section">
        <div className="view-section-head">
          <div>
            <Label>Live system</Label>
            <h2 className="view-h2">Learning curve, sliding 25-incident window</h2>
          </div>
          <Pill>separate from the A/B replay</Pill>
        </div>
        <Panel>
          {curve.length < 2
            ? <EmptyState title="Not enough resolved incidents">
                The curve needs a couple of dozen resolutions before a trend means anything.
                Raise the sim speed in the header and let it run.
              </EmptyState>
            : <LineChart
                height={220}
                clamp01
                area
                endLabels
                xFormat={(x) => `#${Math.round(x)}`}
                yFormat={(y) => fmtPct(y)}
                series={[
                  { id: 'fd', label: 'False dispatch rate', points: curve.map((p) => ({ x: p.incidentIndex, y: p.falseDispatchRate })) },
                  { id: 'mc', label: 'Missed critical rate', points: curve.map((p) => ({ x: p.incidentIndex, y: p.missedCriticalRate })) },
                  { id: 'ag', label: 'Operator agreement', points: curve.map((p) => ({ x: p.incidentIndex, y: p.operatorAgreementRate })) },
                ]}
              />}
        </Panel>
      </section>
    </div>
  );
}

/**
 * The multi-world experiment.
 *
 * A single seeded run answers "did learning win in this world". Because
 * learning is online, that number is a draw from a distribution, so one run
 * cannot distinguish a real effect from a lucky ordering. This runs the same
 * protocol across many independent worlds and reports the interval. If the
 * interval spans zero, the panel says the result is not established rather
 * than quoting the best world.
 */
function ExperimentSection() {
  const [exp, setExp] = useState<Experiment | null>(null);
  const [seedCount, setSeedCount] = useState(20);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const result = await api.runExperiment({ eventCount: 400, seedCount, useClaude: false });
      setExp(result);
      pushToast(
        result.summary.significant
          ? `Learning helps: ${result.summary.wins}/${result.seeds.length} worlds, mean +${result.summary.meanLiftPoints.toFixed(1)} points.`
          : 'Result not established at this sample size. The interval includes zero.',
        result.summary.significant ? 'info' : 'warn',
      );
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Experiment failed', 'error');
    } finally { setBusy(false); }
  };

  return (
    <section className="view-section">
      <div className="view-section-head">
        <div>
          <Label>Does it hold up</Label>
          <h2 className="view-h2">Many worlds, one protocol</h2>
        </div>
        <Pill>the claim, with error bars</Pill>
      </div>

      <div className="eval-controls">
        <div className="eval-control">
          <Label>Worlds</Label>
          <SegmentedControl
            value={seedCount}
            onChange={setSeedCount}
            ariaLabel="Number of worlds"
            options={[
              { value: 10, label: '10' },
              { value: 20, label: '20' },
              { value: 30, label: '30' },
            ]}
          />
        </div>
        <button type="button" className="btn btn--accent" disabled={busy} onClick={() => void run()}>
          {busy ? <Spinner label={`Replaying ${seedCount} worlds`} /> : 'Run the experiment'}
        </button>
        <span className="eval-note">
          Each world is a fresh portfolio with its own hidden truth. Seeds are derived from the
          console seed, so this reproduces exactly.
        </span>
      </div>

      {!exp ? (
        <EmptyState title="Not run yet">
          One run tells you the learned arm won a particular world. It cannot tell you whether
          that was the learning or the ordering. This replays the whole protocol across
          independent worlds and reports how often learning wins, by how much, and how wide the
          interval around that average is.
        </EmptyState>
      ) : <ExperimentResult exp={exp} />}
    </section>
  );
}

function ExperimentResult({ exp }: { exp: Experiment }) {
  const s = exp.summary;
  const span = Math.max(...exp.seeds.map((r) => Math.abs(r.liftPoints)), 1);

  return (
    <>
      <div className="exp-tiles">
        <MetricTile
          label="Worlds where learning won"
          value={`${s.wins}/${exp.seeds.length}`}
          hint={`${fmtPct(s.winRate)} of independently seeded worlds`}
        />
        <MetricTile
          label="Mean lift"
          value={`${s.meanLiftPoints >= 0 ? '+' : ''}${s.meanLiftPoints.toFixed(2)}`}
          unit="pts"
          hero
          hint={`points of dispatch score, ${s.meanLiftPct >= 0 ? '+' : ''}${s.meanLiftPct.toFixed(1)}% of baseline`}
          spark={exp.seeds.map((r) => r.liftPoints)}
        />
        <MetricTile
          label="95% confidence interval"
          value={`${s.ciLowPoints.toFixed(1)} to ${s.ciHighPoints.toFixed(1)}`}
          hint={s.significant
            ? 'Entirely above zero, so the effect is not noise at this sample size.'
            : 'Includes zero, so this run does not establish an effect.'}
        />
        <MetricTile
          label="Of which prior experience"
          value={`${s.meanPriorExperiencePoints >= 0 ? '+' : ''}${s.meanPriorExperiencePoints.toFixed(2)}`}
          unit="pts"
          hint="Learned minus cold: the part attributable to memory carried in, rather than learned during the run."
        />
      </div>

      <Panel
        eyebrow="Per world"
        title={s.significant ? 'Learning helps' : 'Not established at this sample size'}
        actions={<Label>learned minus static, points</Label>}
      >
        {/* Every world is drawn, so nobody has to take the mean on trust. */}
        <ul className="exp-strip">
          {exp.seeds.map((r) => {
            const mag = (Math.abs(r.liftPoints) / span) * 50;
            const pos = r.liftPoints >= 0;
            return (
              <li key={r.seed} className="exp-row" title={`seed ${r.seed}: ${r.staticScore.toFixed(1)} to ${r.learnedScore.toFixed(1)}`}>
                <span className="exp-seed mono">{r.seed}</span>
                <span className="exp-bar" aria-hidden>
                  <span className="exp-bar-mid" />
                  <span
                    className={`exp-bar-fill${pos ? ' is-pos' : ' is-neg'}`}
                    style={{ width: `${mag}%`, [pos ? 'left' : 'right']: '50%' }}
                  />
                </span>
                <span className="exp-val mono">{pos ? '+' : ''}{r.liftPoints.toFixed(1)}</span>
              </li>
            );
          })}
        </ul>
      </Panel>

      <div className="eval-method">
        <Label>Methodology</Label>
        {exp.notes.split('\n').map((line) => <p key={line}>{line}</p>)}
      </div>
    </>
  );
}

function Results({ run, onlyDisagree, setOnlyDisagree }: {
  run: EvalRun; onlyDisagree: boolean; setOnlyDisagree: (v: boolean) => void;
}) {
  const arm = (id: EvalArmId) => run.arms.find((a) => a.id === id);
  const base = arm('static')?.metrics;
  const learned = arm('learned')?.metrics;

  const groups: BarGroup[] = useMemo(() => RATE_ROWS.map((r) => ({
    id: String(r.key),
    label: r.label,
    values: Object.fromEntries(run.arms.map((a) => [a.id, a.metrics[r.key] as number])),
  })), [run]);

  const rows = useMemo(() => {
    const all = arm('learned')?.sampleDecisions ?? [];
    return onlyDisagree ? all.filter((d) => !d.correct) : all;
  }, [run, onlyDisagree]);

  return (
    <>
      <div className="eval-tiles">
        <MetricTile
          hero
          label="Dispatch score"
          value={learned ? learned.dispatchScore.toFixed(1) : '-'}
          delta={learned && base ? learned.dispatchScore - base.dispatchScore : null}
          deltaFormat={(n) => n.toFixed(1)}
          deltaLabel="vs static"
          lowerIsBetter={false}
          hint="Composite. Weighting and justification in docs/METRICS.md."
        />
        {RATE_ROWS.slice(0, 3).map((r) => (
          <MetricTile
            key={String(r.key)}
            label={r.label}
            value={learned ? fmtPct(learned[r.key] as number, 1) : '-'}
            delta={learned && base ? (learned[r.key] as number) - (base[r.key] as number) : null}
            deltaFormat={(n) => fmtPct(n, 1)}
            deltaLabel="vs static"
            lowerIsBetter={r.lowerIsBetter}
          />
        ))}
      </div>

      <Panel eyebrow="All arms" title="Metric by arm" className="eval-panel">
        <GroupedBars
          groups={groups}
          series={ARM_SERIES}
          palette="arm"
          yMax={1}
          height={260}
          format={(v) => fmtPct(v)}
        />
      </Panel>

      <div className="eval-two">
        <Panel eyebrow="Methodology" title="What was held constant">
          <pre className="eval-notes">{run.notes}</pre>
        </Panel>

        <Panel
          eyebrow="Drill-down"
          title={`${rows.length} decisions`}
          actions={<Toggle checked={onlyDisagree} onChange={setOnlyDisagree} label="Errors only" />}
          bodyClassName="eval-table-body"
          scroll
        >
          {rows.length === 0
            ? <EmptyState title="Nothing to show">Every sampled decision in this arm was correct.</EmptyState>
            : (
              <table className="tbl">
                <thead>
                  <tr><th>Zone</th><th>Event</th><th>Action</th><th>Real</th><th className="r">Verdict</th></tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.eventId}>
                      <td className="mono">{d.zoneCode}</td>
                      <td>{d.type.replace(/_/g, ' ')}</td>
                      <td className="mono">{d.action}</td>
                      <td className="mono">{d.wasReal ? 'yes' : 'no'}</td>
                      <td className="r">
                        <span className={`status status--${d.correct ? 'good' : 'crit'}`}>
                          {d.correct ? 'correct' : 'wrong'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Panel>
      </div>

      <div className="view-note is-caveat">
        <strong>What this does and does not prove.</strong> It shows the learning loop closes:
        holding the world, the stream and the judgment engine fixed, memory measurably improves
        dispatch quality. It does <em>not</em> show how the agent performs on real alarm data,
        the regularities here were authored by me, and the agent was built to find them. The
        honest next step is replaying a customer's historical alarm log through the same harness.
      </div>
    </>
  );
}
