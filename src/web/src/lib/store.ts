/**
 * Client state: one immutable `StoreState`, a `useSyncExternalStore` subscription,
 * and a reducer turning each `ServerEvent` into a targeted patch. Selectors must
 * stay referentially stable, that's what keeps re-renders from firing every frame.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { api, connect, getConnection } from './api';
import type { ConnectionInfo } from './api';
import type {
  Briefing, CalibrationCell, EngineStatus, EvalRun, Incident, LearningPoint, Metrics,
  PlaybookProposal, PlaybookRule, ResponderModel, SecurityEvent, ServerEvent,
  SimControls, Snapshot, TraceStep, WorldSnapshot,
} from '../../../shared/types';
import { EMPTY_METRICS } from '../../../shared/types';

// ─────────────────────────────────────────────────────────────────────────────
//  SHAPE
// ─────────────────────────────────────────────────────────────────────────────

export type Theme = 'light' | 'dark';
export type ToastLevel = 'info' | 'warn' | 'error';

/** Which slice of the queue the operator is working. */
export type QueueFilter = 'needs' | 'open' | 'all';

/**
 * Console preferences. Two audiences want different density from one screen
 * (ops wants the decision, engineers want raw tool calls), so both views are a
 * keystroke away rather than averaged into one.
 */
export interface UiPrefs {
  /** The raw event feed column. Off by default, it is context, not work. */
  ingestOpen: boolean;
  /** The tool-call / trace inspector. Off by default, it is the technical view. */
  workOpen: boolean;
  queueFilter: QueueFilter;
  /** True once the first-run walkthrough has been finished or skipped. */
  tourDone: boolean;
  /** Site map height on DISPATCH, dragged by the operator. `null` means the
      CSS default (a viewport-proportional split), not a fixed pixel value. */
  mapHeightPx: number | null;
}

export interface Toast {
  id: string;
  level: ToastLevel;
  message: string;
  /** Real wall clock, for ordering only. */
  ts: number;
}

export interface StoreState {
  snapshot: Snapshot | null;
  connection: ConnectionInfo;
  selectedIncidentId: string | null;
  toasts: Toast[];
  theme: Theme;
  /** True once a full snapshot has landed, views should skeleton until then. */
  ready: boolean;
  /** Last transport error, cleared by the next successful load. */
  error: string | null;
  ui: UiPrefs;
  /**
   * The incident ids the queue is *currently showing*, in display order.
   * Published by the view so `j`/`k` walk what the operator can see rather than
   * the raw arrival order, the two diverge the moment a filter or sort applies.
   */
  queueIds: readonly string[];
}

/** The live feed is a tail, not a log; the server owns the archive. */
const FEED_CAP = 200;
const TOAST_CAP = 5;
const TOAST_TTL_MS = 5200;
const THEME_KEY = 'guardain.theme';
const UI_KEY = 'guardain.ui';

/**
 * Opens on `open`, not `needs`: an empty first frame teaches the operator the
 * console might be broken, and "everything live" always has something in it.
 */
const DEFAULT_UI: UiPrefs = {
  ingestOpen: false, workOpen: false, queueFilter: 'open', tourDone: false, mapHeightPx: null,
};
const NO_IDS: readonly string[] = [];

// Stable fallbacks so selectors never allocate on the null-snapshot path.
const NO_INCIDENTS: readonly Incident[] = [];
const NO_FEED: readonly SecurityEvent[] = [];
const NO_CURVE: readonly LearningPoint[] = [];
const NO_CELLS: readonly CalibrationCell[] = [];
const NO_MODELS: readonly ResponderModel[] = [];
const NO_RULES: readonly PlaybookRule[] = [];
const NO_PROPOSALS: readonly PlaybookProposal[] = [];
const NO_BRIEFINGS: readonly Briefing[] = [];

const EMPTY_WORLD: WorldSnapshot = { sites: [], zones: [], guards: [], robots: [] };
const EMPTY_CONTROLS: SimControls = {
  running: false, speed: 1, seed: 0, simTime: 0, eventsGenerated: 0,
};
const EMPTY_ENGINE: EngineStatus = {
  engine: 'reasoner', model: '-', effort: '-', note: null,
  callsMade: 0, callsFailed: 0, tokensIn: 0, tokensOut: 0, cachedTokensRead: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
//  CORE
// ─────────────────────────────────────────────────────────────────────────────

let state: StoreState = {
  snapshot: null,
  connection: getConnection(),
  selectedIncidentId: null,
  toasts: [],
  theme: initialTheme(),
  ready: false,
  error: null,
  ui: initialUi(),
  queueIds: NO_IDS,
};

const listeners = new Set<() => void>();

export function getState(): StoreState {
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setState(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

/**
 * Selector hook. The selector MUST return a referentially stable value,
 * a slice of state, or an object already living inside it. Never build a new
 * array or object here; derive with `useMemo` in the component instead.
 */
export function useSelector<T>(selector: (s: StoreState) => T): T {
  const read = () => selector(state);
  return useSyncExternalStore(subscribe, read, read);
}

export function useStore(): StoreState {
  return useSyncExternalStore(subscribe, getState, getState);
}

// ─────────────────────────────────────────────────────────────────────────────
//  EVENT REDUCER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trace steps arrive both as their own frames and (later) folded into a
 * re-broadcast incident. Union them by step id, server copy winning, so a
 * locally-streamed step is never dropped by a lagging incident payload.
 */
function mergeIncident(prev: Incident, next: Incident): Incident {
  if (prev.trace.length === 0) return next;
  const byId = new Map<string, TraceStep>();
  for (const s of prev.trace) byId.set(s.id, s);
  for (const s of next.trace) byId.set(s.id, s);
  if (byId.size === next.trace.length) return next;
  const trace = [...byId.values()].sort((a, b) => a.index - b.index);
  return { ...next, trace };
}

function upsertIncident(list: readonly Incident[], next: Incident): Incident[] {
  const i = list.findIndex((x) => x.id === next.id);
  if (i === -1) return [next, ...list];
  const merged = mergeIncident(list[i], next);
  if (merged === list[i]) return list as Incident[];
  const out = list.slice();
  out[i] = merged;
  return out;
}

export function applyServerEvent(e: ServerEvent): void {
  if (e.type === 'toast') {
    pushToast(e.data.message, e.data.level);
    return;
  }
  if (e.type === 'snapshot') {
    setState({ snapshot: e.data, ready: true, error: null });
    return;
  }

  const snap = state.snapshot;
  // Patches that arrive before the first snapshot have nothing to patch.
  if (!snap) return;

  switch (e.type) {
    case 'event': {
      if (snap.feed.some((f) => f.id === e.data.id)) return;
      const feed = [e.data, ...snap.feed];
      if (feed.length > FEED_CAP) feed.length = FEED_CAP;
      setState({ snapshot: { ...snap, feed } });
      return;
    }
    case 'incident': {
      const incidents = upsertIncident(snap.incidents, e.data);
      if (incidents === snap.incidents) return;
      setState({ snapshot: { ...snap, incidents } });
      return;
    }
    case 'trace_step': {
      const { incidentId, step } = e.data;
      const idx = snap.incidents.findIndex((i) => i.id === incidentId);
      if (idx === -1) return;
      const inc = snap.incidents[idx];
      const at = inc.trace.findIndex((s) => s.id === step.id);
      const trace = at === -1
        ? [...inc.trace, step]
        : inc.trace.map((s) => (s.id === step.id ? step : s));
      const incidents = snap.incidents.slice();
      incidents[idx] = { ...inc, trace };
      setState({ snapshot: { ...snap, incidents } });
      return;
    }
    case 'controls':
      setState({ snapshot: { ...snap, controls: e.data } });
      return;
    case 'engine':
      setState({ snapshot: { ...snap, engine: e.data } });
      return;
    case 'metrics':
      setState({
        snapshot: { ...snap, metrics: e.data.metrics, learningCurve: e.data.learningCurve },
      });
      return;
    case 'memory':
      setState({
        snapshot: {
          ...snap,
          calibration: e.data.calibration,
          responderModels: e.data.responderModels,
        },
      });
      return;
    case 'playbook':
      setState({
        snapshot: { ...snap, playbook: e.data.playbook, proposals: e.data.proposals },
      });
      return;
    case 'eval':
      setState({ snapshot: { ...snap, lastEval: e.data } });
      return;
    case 'briefings':
      setState({ snapshot: { ...snap, briefings: e.data } });
      return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

let liveRefs = 0;
let disposeStream: (() => void) | null = null;

export async function refreshSnapshot(): Promise<void> {
  try {
    const snapshot = await api.snapshot();
    setState({ snapshot, ready: true, error: null });
  } catch (err) {
    setState({ error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Open the live connection. Ref-counted so StrictMode's double-mount (and any
 * second consumer) share a single EventSource. Returns a release function.
 */
export function initStore(): () => void {
  liveRefs += 1;
  if (liveRefs === 1) {
    disposeStream = connect(applyServerEvent, (connection) => setState({ connection }));
    void refreshSnapshot();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    liveRefs -= 1;
    if (liveRefs === 0 && disposeStream) {
      disposeStream();
      disposeStream = null;
    }
  };
}

/** Mount-once wrapper around `initStore` for the app shell. */
export function useLiveStore(): void {
  useEffect(() => initStore(), []);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SELECTION
// ─────────────────────────────────────────────────────────────────────────────

export function select(id: string | null): void {
  if (state.selectedIncidentId === id) return;
  setState({ selectedIncidentId: id });
}

export function useSelection(): string | null {
  return useSelector((s) => s.selectedIncidentId);
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOASTS
// ─────────────────────────────────────────────────────────────────────────────

let toastSeq = 0;

export function pushToast(message: string, level: ToastLevel = 'info', ttlMs = TOAST_TTL_MS): string {
  toastSeq += 1;
  const id = `toast-${toastSeq}`;
  const next = [...state.toasts, { id, level, message, ts: Date.now() }];
  setState({ toasts: next.length > TOAST_CAP ? next.slice(next.length - TOAST_CAP) : next });
  if (ttlMs > 0) setTimeout(() => dismissToast(id), ttlMs);
  return id;
}

export function dismissToast(id: string): void {
  if (!state.toasts.some((t) => t.id === id)) return;
  setState({ toasts: state.toasts.filter((t) => t.id !== id) });
}

export function useToasts(): readonly Toast[] {
  return useSelector((s) => s.toasts);
}

// ─────────────────────────────────────────────────────────────────────────────
//  THEME
// ─────────────────────────────────────────────────────────────────────────────

function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function initialTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  const stored = storedTheme();
  if (stored) {
    document.documentElement.dataset.theme = stored;
    return stored;
  }
  // No explicit choice: leave the attribute off so tokens.css follows the OS.
  return systemTheme();
}

export function setTheme(theme: Theme): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode, the session still works, it just won't persist */
  }
  if (state.theme !== theme) setState({ theme });
}

export function toggleTheme(): void {
  setTheme(state.theme === 'dark' ? 'light' : 'dark');
}

export function useTheme(): Theme {
  return useSelector((s) => s.theme);
}

// Track the OS only while the user has made no explicit choice.
if (typeof matchMedia === 'function') {
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', (ev) => {
    if (storedTheme()) return;
    const theme: Theme = ev.matches ? 'dark' : 'light';
    if (state.theme !== theme) setState({ theme });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI PREFERENCES
// ─────────────────────────────────────────────────────────────────────────────

function initialUi(): UiPrefs {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (!raw) return DEFAULT_UI;
    const p = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      ingestOpen: typeof p.ingestOpen === 'boolean' ? p.ingestOpen : DEFAULT_UI.ingestOpen,
      workOpen: typeof p.workOpen === 'boolean' ? p.workOpen : DEFAULT_UI.workOpen,
      queueFilter:
        p.queueFilter === 'needs' || p.queueFilter === 'open' || p.queueFilter === 'all'
          ? p.queueFilter
          : DEFAULT_UI.queueFilter,
      tourDone: typeof p.tourDone === 'boolean' ? p.tourDone : DEFAULT_UI.tourDone,
      mapHeightPx: typeof p.mapHeightPx === 'number' ? p.mapHeightPx : DEFAULT_UI.mapHeightPx,
    };
  } catch {
    // Corrupt or unavailable storage must never cost the operator the console.
    return DEFAULT_UI;
  }
}

export function setUi(patch: Partial<UiPrefs>): void {
  const ui = { ...state.ui, ...patch };
  if (ui.ingestOpen === state.ui.ingestOpen
    && ui.workOpen === state.ui.workOpen
    && ui.queueFilter === state.ui.queueFilter
    && ui.tourDone === state.ui.tourDone
    && ui.mapHeightPx === state.ui.mapHeightPx) return;
  setState({ ui });
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    /* private mode, the preference just won't survive a reload */
  }
}

export function toggleUi(key: 'ingestOpen' | 'workOpen'): void {
  setUi({ [key]: !state.ui[key] } as Partial<UiPrefs>);
}

export function useUi(): UiPrefs {
  return useSelector((s) => s.ui);
}

/** Called by the queue view whenever its visible ordering changes. */
export function setQueueIds(ids: readonly string[]): void {
  const cur = state.queueIds;
  if (cur.length === ids.length && cur.every((id, i) => id === ids[i])) return;
  setState({ queueIds: ids });
}

export function useQueueIds(): readonly string[] {
  return useSelector((s) => s.queueIds);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SELECTORS
// ─────────────────────────────────────────────────────────────────────────────

export function useSnapshot(): Snapshot | null {
  return useSelector((s) => s.snapshot);
}

export function useReady(): boolean {
  return useSelector((s) => s.ready);
}

export function useConnection(): ConnectionInfo {
  return useSelector((s) => s.connection);
}

export function useStoreError(): string | null {
  return useSelector((s) => s.error);
}

export function useIncidents(): readonly Incident[] {
  return useSelector((s) => s.snapshot?.incidents ?? NO_INCIDENTS);
}

export function useIncident(id: string | null): Incident | null {
  return useSelector((s) => {
    if (!id || !s.snapshot) return null;
    return s.snapshot.incidents.find((i) => i.id === id) ?? null;
  });
}

export function useSelectedIncident(): Incident | null {
  return useSelector((s) => {
    const id = s.selectedIncidentId;
    if (!id || !s.snapshot) return null;
    return s.snapshot.incidents.find((i) => i.id === id) ?? null;
  });
}

export function useFeed(): readonly SecurityEvent[] {
  return useSelector((s) => s.snapshot?.feed ?? NO_FEED);
}

export function useWorld(): WorldSnapshot {
  return useSelector((s) => s.snapshot?.world ?? EMPTY_WORLD);
}

export function useControls(): SimControls {
  return useSelector((s) => s.snapshot?.controls ?? EMPTY_CONTROLS);
}

export function useEngine(): EngineStatus {
  return useSelector((s) => s.snapshot?.engine ?? EMPTY_ENGINE);
}

export function useMetrics(): Metrics {
  return useSelector((s) => s.snapshot?.metrics ?? EMPTY_METRICS);
}

export function useLearningCurve(): readonly LearningPoint[] {
  return useSelector((s) => s.snapshot?.learningCurve ?? NO_CURVE);
}

export function useCalibration(): readonly CalibrationCell[] {
  return useSelector((s) => s.snapshot?.calibration ?? NO_CELLS);
}

export function useResponderModels(): readonly ResponderModel[] {
  return useSelector((s) => s.snapshot?.responderModels ?? NO_MODELS);
}

export function usePlaybook(): readonly PlaybookRule[] {
  return useSelector((s) => s.snapshot?.playbook ?? NO_RULES);
}

export function useProposals(): readonly PlaybookProposal[] {
  return useSelector((s) => s.snapshot?.proposals ?? NO_PROPOSALS);
}

export function useLastEval(): EvalRun | null {
  return useSelector((s) => s.snapshot?.lastEval ?? null);
}

export function useBriefings(): readonly Briefing[] {
  return useSelector((s) => s.snapshot?.briefings ?? NO_BRIEFINGS);
}

/** Sim clock, for `relTime` against incident timestamps. */
export function useSimTime(): number {
  return useSelector((s) => s.snapshot?.controls.simTime ?? 0);
}
