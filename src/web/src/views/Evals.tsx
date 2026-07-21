/**
 * EVALS — the proof.
 *
 * Same seeded event stream, three arms, only the memory varies. The methodology
 * block and the "what this does not prove" note are not decoration: a number a
 * founder is asked to trust should come with its caveats attached.
 */

import { useMemo, useState } from 'react';
import type { EvalArmId, EvalRun, Metrics } from '../../../shared/types';
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
              ? 'Runs the judgment layer on Claude. Slower, costs tokens, and non-deterministic — the harness caps it at 120 events.'
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
            rule table, the agent with empty memory, and the agent with trained memory — scoring
            every decision against ground truth the agent never sees.
          </EmptyState>
        ) : <Results run={run} onlyDisagree={onlyDisagree} setOnlyDisagree={setOnlyDisagree} />}
      </section>

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
          value={learned ? learned.dispatchScore.toFixed(1) : '—'}
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
            value={learned ? fmtPct(learned[r.key] as number, 1) : '—'}
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
        dispatch quality. It does <em>not</em> show how the agent performs on real alarm data —
        the regularities here were authored by me, and the agent was built to find them. The
        honest next step is replaying a customer's historical alarm log through the same harness.
      </div>
    </>
  );
}
