/**
 * The console frame.
 *
 * The page itself never scrolls, this is a wall-display tool, so the shell is a
 * fixed grid and only inner panes move. Everything else here is lifecycle: the
 * SSE connection, hash routing, and the global key map.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Header, { VIEWS, type ConnectionState, type ViewId } from './components/Header';
import { Kbd, Toasts } from './components/ui';
import { Tour } from './components/Tour';
import { api } from './lib/api';
import {
  select, setUi, toggleTheme, toggleUi, useConnection, useControls, useLiveStore,
  useQueueIds, useReady, useSelection, useSnapshot, useTheme, useUi,
} from './lib/store';
import Dispatch from './views/Dispatch';
import Memory from './views/Memory';
import Evals from './views/Evals';
import Roster from './views/Roster';
import './App.css';

function readHash(): ViewId {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  return (VIEWS as string[]).includes(raw) ? (raw as ViewId) : 'dispatch';
}

/**
 * Grouped by what the operator is doing, not alphabetically. The first group is
 * the shift-work loop, those four keys run the console without a mouse.
 */
const SHORTCUT_GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: 'Working the queue',
    keys: [
      ['↓ / J', 'Next incident'],
      ['↑ / K', 'Previous incident'],
      ['⏎', 'Looks right, confirm the call'],
      ['O', 'Change it, override the call'],
    ],
  },
  {
    title: 'Seeing more',
    keys: [
      ['E', "Show / hide Sentry's working"],
      ['F', 'Show / hide the raw alarm feed'],
      ['1 – 4', 'Dispatch · Memory · Evals · Roster'],
    ],
  },
  {
    title: 'The world',
    keys: [
      ['Space', 'Play / pause the stream'],
      ['T', 'Light / dark'],
      ['? or Esc', 'Open / close this panel'],
    ],
  },
];

export default function App() {
  useLiveStore();

  const snapshot = useSnapshot();
  const ready = useReady();
  const controls = useControls();
  const queueIds = useQueueIds();
  const selected = useSelection();
  const connection = useConnection();
  const theme = useTheme();

  const ui = useUi();
  const [view, setView] = useState<ViewId>(readHash);
  const [help, setHelp] = useState(false);
  const [tour, setTour] = useState(false);
  const [overrideNonce, setOverrideNonce] = useState(0);
  /** Run state to restore when the walkthrough ends. */
  const resumeAfterTour = useRef(false);

  // Hash routing keeps views linkable and survives a reload.
  useEffect(() => {
    const onHash = () => setView(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((v: ViewId) => {
    window.location.hash = v;
    setView(v);
  }, []);

  const conn: ConnectionState =
    connection.state === 'open' ? 'live'
      : connection.state === 'closed' ? 'lost'
        : connection.state === 'reconnecting' ? 'lost' : 'connecting';

  const setRunning = useCallback((run: boolean) => {
    void (run ? api.startSim() : api.pauseSim()).catch(() => undefined);
  }, []);

  // First run opens the walkthrough once the console has real data to point at.
  // Waiting for `ready` matters: spotlighting an empty shell teaches nothing.
  useEffect(() => {
    if (ready && !ui.tourDone) setTour(true);
  }, [ready, ui.tourDone]);

  const startTour = useCallback(() => {
    setHelp(false);
    setTour(true);
  }, []);

  // A tour whose subject keeps moving cannot be followed, so the world holds
  // still for the duration and is put back exactly as it was.
  useEffect(() => {
    if (!tour) return;
    resumeAfterTour.current = controls?.running ?? false;
    if (resumeAfterTour.current) setRunning(false);
  }, [tour]);

  const endTour = useCallback(() => {
    setTour(false);
    setUi({ tourDone: true });
    if (resumeAfterTour.current) setRunning(true);
    resumeAfterTour.current = false;
  }, [setRunning]);

  // ── keyboard ────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tour) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key >= '1' && e.key <= '4') {
        const next = VIEWS[Number(e.key) - 1];
        if (next) { e.preventDefault(); go(next); }
        return;
      }

      switch (e.key.toLowerCase()) {
        case ' ':
          e.preventDefault();
          setRunning(!(controls?.running ?? false));
          break;
        case 't':
          toggleTheme();
          break;
        case 'e':
          if (view !== 'dispatch') return;
          toggleUi('workOpen');
          break;
        case 'f':
          if (view !== 'dispatch') return;
          toggleUi('ingestOpen');
          break;
        case '?':
        case '/':
          e.preventDefault();
          setHelp((v) => !v);
          break;
        case 'escape':
          setHelp(false);
          break;
        // Arrows alias j/k so nobody has to know vi to work a shift.
        case 'j':
        case 'k':
        case 'arrowdown':
        case 'arrowup': {
          if (view !== 'dispatch' || queueIds.length === 0) return;
          e.preventDefault();
          const down = e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown';
          const at = selected ? queueIds.indexOf(selected) : -1;
          const next = at === -1 ? 0 : Math.max(0, Math.min(queueIds.length - 1, at + (down ? 1 : -1)));
          select(queueIds[next]!);
          break;
        }
        // Enter is the confirm key; `a` stays as a muscle-memory alias.
        case 'enter':
        case 'a': {
          if (view !== 'dispatch' || !selected) return;
          e.preventDefault();
          void api.feedback(selected, { verdict: 'confirm', operator: 'console' })
            .catch(() => undefined);
          break;
        }
        case 'o': {
          if (view !== 'dispatch' || !selected) return;
          e.preventDefault();
          setOverrideNonce((n) => n + 1);
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controls?.running, go, queueIds, selected, setRunning, view, tour]);

  const body = useMemo(() => {
    switch (view) {
      case 'memory': return <Memory />;
      case 'evals': return <Evals />;
      case 'roster': return <Roster />;
      default: return <Dispatch overrideNonce={overrideNonce} />;
    }
  }, [view, overrideNonce]);

  return (
    <div className="app">
      <Header
        snapshot={snapshot}
        controls={controls}
        connection={conn}
        active={view}
        onSetRunning={setRunning}
        onSetSpeed={(s) => { void api.setSpeed(s).catch(() => undefined); }}
        onSetSeed={(s) => { void api.setSeed(s).catch(() => undefined); }}
        theme={theme}
        onToggleTheme={toggleTheme}
        onHelp={() => setHelp(true)}
      />

      {conn === 'lost' && (
        <div className="app-banner" role="alert">
          <span className="status status--crit status--live">Stream lost</span>
          <span>Reconnecting to the dispatch server. The console is showing the last known state.</span>
        </div>
      )}

      <main className="app-body">
        {!ready ? <Booting /> : body}
      </main>

      {help && (
        <div className="help-scrim" onClick={() => setHelp(false)} role="presentation">
          <div className="help-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
            <div className="panel-head">
              <div className="ui-panel-titles">
                <span className="label">Keyboard</span>
                <div className="ui-panel-title">Run it without a mouse</div>
              </div>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setHelp(false)}>Close</button>
            </div>
            <div className="help-body">
              <button type="button" className="tour-start" onClick={startTour}>
                <span className="tour-start-title">Replay the walkthrough</span>
                <span className="tour-start-sub">7 steps, about a minute</span>
              </button>
              {SHORTCUT_GROUPS.map((group) => (
                <section key={group.title} className="help-group">
                  <span className="label">{group.title}</span>
                  <dl className="help-list">
                    {group.keys.map(([k, d]) => (
                      <div className="help-row" key={k}>
                        <dt><Kbd>{k}</Kbd></dt>
                        <dd>{d}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}

      {tour && <Tour onClose={endTour} onGoView={go} />}

      <Toasts />
    </div>
  );
}

function Booting() {
  return (
    <div className="app-boot">
      <div className="app-boot-mark" aria-hidden />
      <h1 className="display display--l">Connecting<span className="dot-accent" /></h1>
      <p className="app-boot-copy">
        Attaching to the dispatch stream. If this persists, start the API with
        {' '}<code>npm run dev:server</code>.
      </p>
    </div>
  );
}
