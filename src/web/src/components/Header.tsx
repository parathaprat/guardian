import { useEffect, useRef, useState } from 'react';
import type { EngineStatus, Incident, SimControls, Snapshot } from '../../../shared/types';
import './Header.css';

// ─── Routing vocabulary. The header renders the tab bar, so it owns the table. ──

export type ViewId = 'dispatch' | 'memory' | 'evals' | 'roster';
export type ConnectionState = 'connecting' | 'live' | 'lost';
export type ThemeName = 'light' | 'dark';

export const VIEWS: ViewId[] = ['dispatch', 'memory', 'evals', 'roster'];

const TAB_LABEL: Record<ViewId, string> = {
  dispatch: 'Dispatch',
  memory: 'Memory',
  evals: 'Evals',
  roster: 'Roster',
};

const SPEEDS: readonly number[] = [1, 4, 16, 64];

/** Anything not yet closed out counts against the operator's attention. */
const OPEN_STATUSES: ReadonlySet<Incident['status']> = new Set<Incident['status']>([
  'triaging', 'open', 'dispatched', 'on_scene', 'escalated',
]);

export interface HeaderProps {
  /** Server truth. Null until the first snapshot lands. */
  snapshot: Snapshot | null;
  /** Controls with the shell's optimistic overlay already applied. */
  controls: SimControls | null;
  connection: ConnectionState;
  active: ViewId;
  onSetRunning: (running: boolean) => void;
  onSetSpeed: (speed: number) => void;
  onSetSeed: (seed: number) => void;
  theme: ThemeName;
  onToggleTheme: () => void;
  onHelp: () => void;
}

export default function Header({
  snapshot, controls, connection, active,
  onSetRunning, onSetSpeed, onSetSeed,
  theme, onToggleTheme, onHelp,
}: HeaderProps) {
  const running = controls?.running ?? false;
  const clock = useSimClock(controls);

  let openCount = 0;
  let hot = false;
  for (const inc of snapshot?.incidents ?? []) {
    if (!OPEN_STATUSES.has(inc.status)) continue;
    openCount += 1;
    const p = inc.decision?.priority;
    if (p === 'P0' || p === 'P1') hot = true;
  }

  const liveState = connection === 'lost' ? 'lost' : running && connection === 'live' ? 'live' : 'idle';

  return (
    <header className="hdr">
      <div className="hdr-left">
        <a className="hdr-word" href="#dispatch" aria-label="Calvis. Sentry home">
          Calvis<span className="dot-accent" />
        </a>
        <span className="hdr-rule" aria-hidden="true" />
        <span className="hdr-product">
          <span className="label hdr-name">Sentry</span>
          <span className="label hdr-desc">AI Dispatch</span>
        </span>
      </div>

      <nav className="hdr-tabs" aria-label="Views">
        {VIEWS.map((view, i) => (
          <a
            key={view}
            className="hdr-tab"
            href={`#${view}`}
            aria-current={view === active ? 'page' : undefined}
          >
            <span className="hdr-tab-k" aria-hidden="true">{i + 1}</span>
            {TAB_LABEL[view]}
            {view === 'dispatch' && openCount > 0 && (
              <span className="hdr-badge" data-hot={hot ? '1' : undefined}>
                {openCount}
                <span className="sr-only"> open incidents</span>
              </span>
            )}
          </a>
        ))}
      </nav>

      <div className="hdr-right">
        <div className="hdr-clock">
          <span className="hdr-clock-top">
            <span className="hdr-live" data-state={liveState} aria-hidden="true" />
            <span className="label">Sim · UTC</span>
          </span>
          <span className="hdr-clock-v mono">
            {clock ? (
              <>
                <span className="hdr-clock-d">{clock.date}</span>{' '}
                <span className="hdr-clock-t">{clock.time}</span>
              </>
            ) : (
              <span className="hdr-clock-d">{'----------  --:--:--'}</span>
            )}
          </span>
        </div>

        <span className="hdr-rule" aria-hidden="true" />

        <div className="hdr-transport">
          <button
            type="button"
            className="btn btn--sm btn--icon hdr-play"
            onClick={() => onSetRunning(!running)}
            disabled={!controls}
            aria-label={running ? 'Pause simulation' : 'Start simulation'}
            title={running ? 'Pause (Space)' : 'Play (Space)'}
          >
            {running ? <PauseIcon /> : <PlayIcon />}
          </button>

          <div className="hdr-seg" role="group" aria-label="Simulation speed">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                className="hdr-seg-b"
                aria-pressed={controls?.speed === s}
                disabled={!controls}
                onClick={() => onSetSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </div>

          <SeedField seed={controls?.seed ?? null} onCommit={onSetSeed} />
        </div>

        <span className="hdr-rule" aria-hidden="true" />

        <EnginePill engine={snapshot?.engine ?? null} />

        <button
          type="button"
          className="btn btn--sm btn--icon hdr-sq"
          onClick={onHelp}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          ?
        </button>

        <button
          type="button"
          className="btn btn--sm btn--icon hdr-sq"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title="Toggle theme (T)"
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );
}

// ─── Sim clock ────────────────────────────────────────────────────────────────

/**
 * The server only emits `controls` on state changes, so the displayed clock is
 * interpolated between them: sim ms advance at `speed` × real ms while running.
 * Date.now() here is real wall-clock for UI smoothing only, it never touches
 * simulation or memory logic.
 */
function useSimClock(controls: SimControls | null): { date: string; time: string } | null {
  const [, setTick] = useState(0);
  const anchor = useRef<{ sim: number; real: number } | null>(null);
  const simTime = controls?.simTime ?? null;
  const running = controls?.running ?? false;

  useEffect(() => {
    if (simTime === null) return;
    anchor.current = { sim: simTime, real: Date.now() };
  }, [simTime]);

  useEffect(() => {
    if (!running) return;
    const h = window.setInterval(() => setTick((t) => (t + 1) % 1000), 200);
    return () => window.clearInterval(h);
  }, [running]);

  if (!controls) return null;
  const a = anchor.current ?? { sim: controls.simTime, real: Date.now() };
  const ts = running ? a.sim + (Date.now() - a.real) * controls.speed : controls.simTime;
  return utcParts(ts);
}

function utcParts(ts: number): { date: string; time: string } {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}

// ─── Seed ─────────────────────────────────────────────────────────────────────

/** Editable in place: a seed you cannot change is a seed you cannot reproduce. */
function SeedField({ seed, onCommit }: { seed: number | null; onCommit: (seed: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (seed === null ? '' : String(seed));

  const commit = () => {
    if (draft === null) return;
    const next = Number.parseInt(draft, 10);
    setDraft(null);
    if (Number.isSafeInteger(next) && next !== seed) onCommit(next);
  };

  return (
    <label className="hdr-seed">
      <span className="label">Seed</span>
      <input
        className="hdr-seed-in"
        value={value}
        inputMode="numeric"
        spellCheck={false}
        disabled={seed === null}
        aria-label="Simulation seed, press Enter to reseed"
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9-]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); e.currentTarget.blur(); }
          if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
        }}
      />
    </label>
  );
}

// ─── Engine ───────────────────────────────────────────────────────────────────

function EnginePill({ engine }: { engine: EngineStatus | null }) {
  const isClaude = engine?.engine === 'claude';
  const text = engine === null
    ? 'Engine ·,'
    : isClaude
      ? `Claude · ${prettyModel(engine.model)}`
      : 'Reasoner · Local';

  return (
    <div className="hdr-engine">
      <button
        type="button"
        className="hdr-engine-btn"
        data-engine={isClaude ? 'claude' : 'reasoner'}
        aria-label={`Decision engine: ${text}`}
      >
        {engine?.note && <span className="hdr-engine-warn" aria-hidden="true" />}
        {text}
      </button>
      <div className="hdr-pop" role="tooltip">
        <div className="label hdr-pop-head">Decision engine</div>
        <PopRow k="Model" v={engine?.model ?? '-'} />
        <PopRow k="Effort" v={engine?.effort ?? '-'} />
        <div className="hdr-pop-sep" />
        <PopRow k="Calls" v={num(engine?.callsMade)} />
        <PopRow k="Failed" v={num(engine?.callsFailed)} warn={(engine?.callsFailed ?? 0) > 0} />
        <div className="hdr-pop-sep" />
        <PopRow k="Tokens in" v={num(engine?.tokensIn)} />
        <PopRow k="Tokens out" v={num(engine?.tokensOut)} />
        <PopRow k="Cache read" v={num(engine?.cachedTokensRead)} />
        {engine?.note && <p className="hdr-pop-note">{engine.note}</p>}
      </div>
    </div>
  );
}

function PopRow({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="hdr-pop-row">
      <span className="label">{k}</span>
      <span className="mono hdr-pop-v" data-warn={warn ? '1' : undefined}>{v}</span>
    </div>
  );
}

const FMT = new Intl.NumberFormat('en-US');
function num(v: number | undefined): string {
  return v === undefined ? '-' : FMT.format(v);
}

/** `claude-opus-4-8[1m]` → `Opus 4.8`. Falls back to the raw id, uppercased. */
function prettyModel(id: string): string {
  const base = id.replace(/^claude-/, '').replace(/-(latest|\d{8})$/, '');
  const m = /^(opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(base);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}.${m[3]}`;
  return base.replace(/[-_]/g, ' ');
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function PlayIcon() {
  return (
    <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true" focusable="false">
      <path d="M0 0 L9 5 L0 10 Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="3" height="10" fill="currentColor" />
      <rect x="5" y="0" width="3" height="10" fill="currentColor" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="4" height="4" fill="currentColor" />
      <rect x="5.25" y="0" width="1.5" height="2" fill="currentColor" />
      <rect x="5.25" y="10" width="1.5" height="2" fill="currentColor" />
      <rect x="0" y="5.25" width="2" height="1.5" fill="currentColor" />
      <rect x="10" y="5.25" width="2" height="1.5" fill="currentColor" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M11 7.5A5.5 5.5 0 0 1 4.5 1 5.5 5.5 0 1 0 11 7.5Z" fill="currentColor" />
    </svg>
  );
}
