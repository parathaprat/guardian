/**
 * ROSTER, guards and robots as learned assets.
 *
 * Every number in the "learned" columns came from watching dispatches resolve.
 * None of it is configured, and the hidden parameters the simulator uses to
 * generate these outcomes are stripped server-side before the snapshot ships.
 */

import { useMemo } from 'react';
import type { ResponderModel } from '../../../shared/types';
import { ConfidenceBar, EmptyState, Label, Panel, Pill, ResponderStatusDot } from '../components/ui';
import { fmtDuration, fmtPct, initials } from '../lib/format';
import { useResponderModels, useWorld } from '../lib/store';
import './views.css';

export default function Roster() {
  const world = useWorld();
  const models = useResponderModels();

  const byId = useMemo(() => {
    const m = new Map<string, ResponderModel>();
    for (const x of models) m.set(x.responderId, x);
    return m;
  }, [models]);

  const guards = useMemo(() => [...world.guards].sort((a, b) => {
    const am = byId.get(a.id)?.score ?? 0;
    const bm = byId.get(b.id)?.score ?? 0;
    return bm - am;
  }), [world.guards, byId]);

  const exploring = models.filter((m) => m.exploring).length;
  const zoneName = (id: string) => world.zones.find((z) => z.id === id)?.code ?? '-';
  const siteCode = (id: string) => world.sites.find((s) => s.id === id)?.code ?? '-';

  return (
    <div className="view scroll">
      <header className="view-head">
        <div>
          <Label>Roster</Label>
          <h1 className="display display--l">Learned, not<br />configured<span className="dot-accent" /></h1>
          <p className="view-lede">
            Accept rate, response time and resolution quality are posteriors built from observed
            outcomes. Dispatch selection samples from them (Thompson sampling), so the agent keeps
            testing under-observed responders instead of over-trusting the ones it happens to know.
          </p>
        </div>
        <div className="view-stats">
          <Stat label="Guards" value={world.guards.length} />
          <Stat label="Robots" value={world.robots.length} />
          <Stat label="Exploring" value={exploring} accent={exploring > 0} />
          <Stat label="Exploiting" value={Math.max(0, models.length - exploring)} />
        </div>
      </header>

      <section className="view-section">
        <div className="view-section-head">
          <div>
            <Label>Guards</Label>
            <h2 className="view-h2">Ranked by learned score</h2>
          </div>
        </div>

        <Panel bodyClassName="roster-body">
          {guards.length === 0 ? <EmptyState title="No roster" /> : (
            <table className="tbl roster-tbl">
              <thead>
                <tr>
                  <th>Guard</th><th>Site</th><th>Shift</th><th>Skills</th><th>Status</th>
                  {/* Mean, not median: responders.ts keeps Welford running
                      stats, and the mean is the term that feeds the score. */}
                  <th className="r">Accept rate</th><th className="r">Mean response</th>
                  <th className="r">Resolved</th><th className="r">Dispatches</th>
                </tr>
              </thead>
              <tbody>
                {guards.map((g) => {
                  const m = byId.get(g.id);
                  return (
                    <tr key={g.id}>
                      <td>
                        <div className="row gap2">
                          <span className="avatar" aria-hidden>{initials(g.name)}</span>
                          <div className="col">
                            <span>{g.name}</span>
                            <span className="mono muted roster-badge">{g.badge} · {zoneName(g.currentZoneId)}</span>
                          </div>
                        </div>
                      </td>
                      <td className="mono">{siteCode(g.siteId)}</td>
                      <td className="mono muted">
                        {String(g.shift.start).padStart(2, '0')}–{String(g.shift.end).padStart(2, '0')}
                      </td>
                      <td>
                        <div className="skills">
                          {g.skills.map((s) => <Pill key={s}>{s.replace(/_/g, ' ')}</Pill>)}
                        </div>
                      </td>
                      <td><ResponderStatusDot status={g.status} /></td>
                      {/* Before the first offer this is the 2/1 prior, not an
                          observation. It still ranks, so it is shown, but it is
                          dimmed: 67% next to a hard 89% otherwise reads as a
                          measurement nobody took. */}
                      <td className="r">
                        {m ? (
                          <div
                            className={`cell-meter${m.dispatches === 0 ? ' is-prior' : ''}`}
                            title={m.dispatches === 0 ? 'Prior only, no offers observed yet' : undefined}
                          >
                            <ConfidenceBar value={m.pAccept} className="roster-meter" />
                            <span className="mono">{fmtPct(m.pAccept)}</span>
                          </div>
                        ) : <span className="muted">-</span>}
                      </td>
                      <td className="r mono">{m && m.responseCount > 0 ? fmtDuration(m.responseMeanMs) : '-'}</td>
                      <td className="r mono">{m && m.dispatches > 0 ? fmtPct(m.pResolve) : '-'}</td>
                      <td className="r mono">
                        {m?.dispatches ?? 0}
                        {m?.exploring && <Pill tone="accent" className="roster-explore">exploring</Pill>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
        <p className="view-caption">
          <b>Accept rate</b> is the share of dispatch offers this responder took, as a Beta
          posterior seeded 2/1 so an unknown responder starts optimistic rather than at zero.
          <b> Mean response</b> is dispatch to on-scene, averaged over arrivals actually observed.
          <b> Resolved</b> is the share of their dispatches that closed correctly.
          <b> Dispatches</b> is how many offers the number rests on; under five the model is still
          <i> exploring</i>, so ranking samples from the posterior instead of trusting its mean.
          None of this is read from the roster file: every guard has hidden traits the agent is
          never shown, and these are its estimates of them from revealed outcomes.
        </p>
      </section>

      <section className="view-section">
        <div className="view-section-head">
          <div>
            <Label>Robots</Label>
            <h2 className="view-h2">Patrol fleet</h2>
          </div>
        </div>
        <Panel bodyClassName="roster-body">
          {world.robots.length === 0 ? <EmptyState title="No fleet" /> : (
            <table className="tbl roster-tbl">
              <thead>
                <tr><th>Robot</th><th>Model</th><th>Site</th><th>Patrol</th><th>Battery</th><th>Status</th></tr>
              </thead>
              <tbody>
                {world.robots.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td className="mono muted">{r.model}</td>
                    <td className="mono">{siteCode(r.siteId)}</td>
                    <td className="mono muted">{r.patrolZoneIds.map(zoneName).join(' → ')}</td>
                    <td>
                      <div className="cell-meter">
                        <ConfidenceBar value={r.batteryPct / 100} tone="neutral" className="roster-meter" />
                        <span className="mono">{Math.round(r.batteryPct)}%</span>
                      </div>
                    </td>
                    <td><ResponderStatusDot status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <div className="view-note">
          A degraded sensor on one of these units is a real fault in this world, and the agent is
          not told which. It has to infer it from the fact that a particular unit's alarms keep
          resolving false, which is exactly what the calibration channel is for.
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="stat">
      <Label>{label}</Label>
      <div className={`stat-num${accent ? ' is-accent' : ''}`}>{value}</div>
    </div>
  );
}
