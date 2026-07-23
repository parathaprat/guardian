/**
 * Redis pub/sub seam between the stateless API and the worker that owns the
 * world: events flow worker to API, commands flow API to worker. See
 * DECISIONS.md (Decision 8) and docs/ARCHITECTURE.md for the full rationale.
 */

import Redis from 'ioredis';
import type { ServerEvent } from '../shared/types';

export const EVENT_CHANNEL = 'guardain:events';
export const COMMAND_CHANNEL = 'guardain:commands';
export const HEARTBEAT_KEY = 'guardain:worker:alive';

export const COMMAND_TIMEOUT_MS = 120_000;

export interface CommandRequest {
  id: string;
  method: string;
  params: unknown;
}

export type CommandReply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

export function replyChannel(id: string): string {
  return `guardain:reply:${id}`;
}

/**
 * A subscriber connection cannot issue normal commands, so every user of the
 * bus holds two: one in subscriber mode, one for publishing.
 */
export class Bus {
  private pub: Redis;
  private sub: Redis;
  private seq = 0;
  private listeners = new Set<(e: ServerEvent) => void>();

  constructor(url: string) {
    const opts = {
      maxRetriesPerRequest: null,
      // A console that reconnects forever is better than one that gives up.
      retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    };
    this.pub = new Redis(url, opts);
    this.sub = new Redis(url, opts);
    this.pub.on('error', (e) => console.error('[bus] publish connection:', e.message));
    this.sub.on('error', (e) => console.error('[bus] subscribe connection:', e.message));
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }

  // ── events, worker to api ───────────────────────────────────────────────

  publishEvent(e: ServerEvent): void {
    // Fire and forget: a broadcast that fails is corrected by the next
    // snapshot, and awaiting it would put Redis latency inside the tick loop.
    void this.pub.publish(EVENT_CHANNEL, JSON.stringify(e)).catch(() => undefined);
  }

  /** Called once per API process; SSE clients attach via `onLocalEvent` so N clients share one Redis subscription. */
  async relayEvents(): Promise<void> {
    await this.sub.subscribe(EVENT_CHANNEL);
    this.sub.on('message', (channel, payload) => {
      if (channel !== EVENT_CHANNEL) return;
      let event: ServerEvent;
      try {
        event = JSON.parse(payload) as ServerEvent;
      } catch {
        return; // a malformed frame is not worth taking the stream down for
      }
      for (const fn of this.listeners) {
        try { fn(event); } catch { /* a dead client must not break the relay */ }
      }
    });
  }

  /** Attach to the relayed stream. Returns an unsubscribe, same shape as `OpsEngine.subscribe`. */
  onLocalEvent(fn: (e: ServerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── commands, api to worker ─────────────────────────────────────────────

  /**
   * Subscribes to the reply channel *before* publishing. Reversed, a fast
   * worker can answer before anyone is listening and the caller times out.
   */
  async call<T>(method: string, params: unknown = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    const id = `${process.pid.toString(36)}-${(++this.seq).toString(36)}-${Math.trunc(performance.now())}`;
    const channel = replyChannel(id);
    const listener = this.sub.duplicate();

    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`the worker did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);

        listener.on('message', (_ch, payload) => {
          clearTimeout(timer);
          try {
            const reply = JSON.parse(payload) as CommandReply;
            if (reply.ok) resolve(reply.result as T);
            else reject(new Error(reply.error));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });

        listener.subscribe(channel).then(
          () => {
            const req: CommandRequest = { id, method, params };
            void this.pub.publish(COMMAND_CHANNEL, JSON.stringify(req));
          },
          (err: unknown) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });
    } finally {
      void listener.quit().catch(() => undefined);
    }
  }

  /**
   * The worker serves no HTTP, so it can't answer a container healthcheck.
   * A TTL key that must be refreshed proves the event loop and Redis are alive.
   */
  startHeartbeat(intervalMs = 10_000, ttlSeconds = 30): NodeJS.Timeout {
    const beat = () => { void this.pub.set(HEARTBEAT_KEY, Date.now().toString(), 'EX', ttlSeconds); };
    beat();
    const timer = setInterval(beat, intervalMs);
    timer.unref?.();
    return timer;
  }

  /** Worker side: handle commands, replying on the caller's private channel. */
  async serve(handler: (method: string, params: unknown) => Promise<unknown>): Promise<void> {
    await this.sub.subscribe(COMMAND_CHANNEL);
    this.sub.on('message', (channel, payload) => {
      if (channel !== COMMAND_CHANNEL) return;
      let req: CommandRequest;
      try {
        req = JSON.parse(payload) as CommandRequest;
      } catch {
        return;
      }
      void (async () => {
        let reply: CommandReply;
        try {
          reply = { id: req.id, ok: true, result: await handler(req.method, req.params) };
        } catch (err) {
          reply = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        await this.pub.publish(replyChannel(req.id), JSON.stringify(reply)).catch(() => undefined);
      })();
    });
  }
}

export function createBus(env: NodeJS.ProcessEnv = process.env): Bus | null {
  const url = env.REDIS_URL?.trim();
  return url ? new Bus(url) : null;
}
