/**
 * Typed transport to the SENTRY server: one thin wrapper per REST route plus
 * the SSE subscription.
 *
 * The stream is the primary channel — REST is used for control actions and the
 * cold-start snapshot. Reconnection is ours rather than EventSource's default so
 * the backoff is bounded and observable in the UI.
 */

import type {
  AgentActionKind, EvalRun, EventType, OperatorFeedback, PlaybookProposal,
  Priority, RuleStatus, ServerEvent, Snapshot,
} from '../../../shared/types';

/** Overridable before bundle load (e.g. a static build pointed at a remote API). */
export const API_BASE: string =
  (globalThis as { SENTRY_API_BASE?: string }).SENTRY_API_BASE ?? '/api';

export interface Ok {
  ok: true;
}

/** Body of POST /api/incidents/:id/feedback — the server stamps ts + operator. */
export interface FeedbackInput {
  verdict: OperatorFeedback['verdict'];
  correctedAction?: AgentActionKind;
  correctedPriority?: Priority;
  correctedResponderId?: string | null;
  note?: string;
  operator?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
  }

  /** status 0 means the request never reached the server. */
  get offline(): boolean {
    return this.status === 0;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError(0, url, err instanceof Error ? err.message : 'network unreachable');
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new ApiError(res.status, url, extractError(text) ?? `${res.status} ${res.statusText}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, url, 'malformed JSON in response');
  }
}

function extractError(body: string): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const e = (parsed as { error: unknown }).error;
      if (typeof e === 'string') return e;
    }
  } catch {
    /* plain-text error body */
  }
  return body.slice(0, 240);
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const enc = encodeURIComponent;

export const api = {
  snapshot: (): Promise<Snapshot> => get<Snapshot>('/snapshot'),

  startSim: (): Promise<Ok> => post<Ok>('/sim/start'),
  pauseSim: (): Promise<Ok> => post<Ok>('/sim/pause'),
  setSpeed: (speed: number): Promise<Ok> => post<Ok>('/sim/speed', { speed }),
  setSeed: (seed: number): Promise<Ok> => post<Ok>('/sim/seed', { seed }),
  injectEvent: (type: EventType, zoneId: string): Promise<Ok> =>
    post<Ok>('/sim/inject', { type, zoneId }),

  feedback: (incidentId: string, fb: FeedbackInput): Promise<Ok> =>
    post<Ok>(`/incidents/${enc(incidentId)}/feedback`, fb),

  reflect: (): Promise<PlaybookProposal> => post<PlaybookProposal>('/playbook/reflect'),
  applyProposal: (proposalId: string, accept: string[], reject: string[]): Promise<Ok> =>
    post<Ok>(`/playbook/proposals/${enc(proposalId)}/apply`, { accept, reject }),
  dismissProposal: (proposalId: string): Promise<Ok> =>
    post<Ok>(`/playbook/proposals/${enc(proposalId)}/dismiss`),
  setRuleStatus: (ruleId: string, status: RuleStatus): Promise<Ok> =>
    post<Ok>(`/playbook/rules/${enc(ruleId)}/status`, { status }),

  runEval: (opts: { eventCount: number; useClaude: boolean }): Promise<EvalRun> =>
    post<EvalRun>('/evals/run', opts),

  resetMemory: (): Promise<Ok> => post<Ok>('/memory/reset'),
};

// ─────────────────────────────────────────────────────────────────────────────
//  STREAM
// ─────────────────────────────────────────────────────────────────────────────

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnectionInfo {
  state: ConnectionState;
  /** Consecutive failed opens. Resets to 0 on a successful open. */
  attempts: number;
  /** Wall-clock ms the current state began — real time, not sim time. */
  since: number;
  error: string | null;
}

/** Bounded ladder, no jitter: a single browser tab does not need decorrelation. */
const BACKOFF_MS = [400, 900, 1800, 3500, 7000, 15_000, 30_000];

let connection: ConnectionInfo = { state: 'idle', attempts: 0, since: 0, error: null };
const connectionListeners = new Set<(c: ConnectionInfo) => void>();

export function getConnection(): ConnectionInfo {
  return connection;
}

export function onConnection(fn: (c: ConnectionInfo) => void): () => void {
  connectionListeners.add(fn);
  return () => {
    connectionListeners.delete(fn);
  };
}

function setConnection(next: Omit<ConnectionInfo, 'since'>): void {
  const prev = connection;
  if (prev.state === next.state && prev.attempts === next.attempts && prev.error === next.error) return;
  connection = { ...next, since: Date.now() };
  for (const fn of connectionListeners) fn(connection);
}

/**
 * Subscribe to `/api/stream`. Returns a disposer; call it on unmount.
 * `onState` is a convenience mirror of the module-level connection signal.
 */
export function connect(
  onEvent: (e: ServerEvent) => void,
  onState?: (c: ConnectionInfo) => void,
): () => void {
  const offState = onState ? onConnection(onState) : null;
  if (onState) onState(connection);

  if (typeof EventSource === 'undefined') {
    setConnection({ state: 'closed', attempts: 0, error: 'EventSource is unavailable' });
    return () => {
      offState?.();
    };
  }

  let disposed = false;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;

  const open = (): void => {
    if (disposed) return;
    setConnection({
      state: attempts === 0 ? 'connecting' : 'reconnecting',
      attempts,
      error: connection.error,
    });

    const src = new EventSource(`${API_BASE}/stream`);
    source = src;

    src.onopen = () => {
      if (disposed) return;
      attempts = 0;
      setConnection({ state: 'open', attempts: 0, error: null });
    };

    src.onmessage = (ev: MessageEvent<string>) => {
      if (disposed) return;
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(ev.data) as ServerEvent;
      } catch {
        return; // a torn frame is not worth tearing down the stream for
      }
      onEvent(parsed);
    };

    src.onerror = () => {
      src.close();
      if (source === src) source = null;
      if (disposed) return;
      const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
      attempts += 1;
      setConnection({ state: 'reconnecting', attempts, error: 'stream interrupted' });
      timer = setTimeout(open, wait);
    };
  };

  open();

  return () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    source?.close();
    source = null;
    setConnection({ state: 'closed', attempts: 0, error: null });
    offState?.();
  };
}
