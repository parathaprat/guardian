/**
 * HTTP surface. One SSE stream plus a small command API.
 *
 * Everything validates defensively: a malformed POST returns 400, never a 500,
 * and never takes the dispatch loop down with it.
 */

import { Router, type Request, type Response } from 'express';
import type { AgentActionKind, EventType, OperatorFeedback, Priority, RuleStatus } from '../../shared/types';
import { ALL_EVENT_TYPES } from '../../shared/types';
import type { OpsEngine } from '../engine';

const ACTIONS: AgentActionKind[] = ['dispatch', 'escalate', 'monitor', 'suppress'];
const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];
const RULE_STATUSES: RuleStatus[] = ['proposed', 'active', 'rejected', 'retired'];

function bad(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

/** Wrap an async handler so a rejected promise becomes a 500 JSON body, not a crash. */
function guard(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.status(500).json({ error: message });
    }
  };
}

export function createRouter(engine: OpsEngine): Router {
  const router = Router();

  router.get('/snapshot', guard((_req, res) => {
    res.json(engine.snapshot());
  }));

  // ── SSE ────────────────────────────────────────────────────────────────
  router.get('/stream', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Streaming dies under Nagle, send small frames immediately.
    res.socket?.setNoDelay(true);

    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send({ type: 'snapshot', data: engine.snapshot() });
    const unsubscribe = engine.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  // ── simulation transport ───────────────────────────────────────────────
  router.post('/sim/start', guard((_req, res) => { engine.start(); res.json({ ok: true }); }));
  router.post('/sim/pause', guard((_req, res) => { engine.pause(); res.json({ ok: true }); }));

  router.post('/sim/speed', guard((req, res) => {
    const speed = Number((req.body ?? {}).speed);
    if (!Number.isFinite(speed) || speed <= 0) return bad(res, 'speed must be a positive number');
    engine.setSpeed(speed);
    res.json({ ok: true, speed });
  }));

  router.post('/sim/seed', guard((req, res) => {
    const seed = Number((req.body ?? {}).seed);
    if (!Number.isInteger(seed)) return bad(res, 'seed must be an integer');
    engine.reseed(seed);
    res.json({ ok: true, seed });
  }));

  router.post('/sim/inject', guard((req, res) => {
    const { type, zoneId } = (req.body ?? {}) as { type?: string; zoneId?: string };
    if (!type || !ALL_EVENT_TYPES.includes(type as EventType)) return bad(res, 'unknown event type');
    if (typeof zoneId !== 'string' || zoneId.length === 0) return bad(res, 'zoneId is required');
    engine.injectEvent(type as EventType, zoneId);
    res.json({ ok: true });
  }));

  // ── operator feedback ──────────────────────────────────────────────────
  router.post('/incidents/:id/feedback', guard((req, res) => {
    const body = (req.body ?? {}) as Partial<OperatorFeedback> & { operator?: string };
    if (body.verdict !== 'confirm' && body.verdict !== 'override') {
      return bad(res, "verdict must be 'confirm' or 'override'");
    }
    if (body.verdict === 'override' && body.correctedAction && !ACTIONS.includes(body.correctedAction)) {
      return bad(res, 'unknown correctedAction');
    }
    if (body.correctedPriority && !PRIORITIES.includes(body.correctedPriority)) {
      return bad(res, 'unknown correctedPriority');
    }
    try {
      engine.feedback(String(req.params.id), {
        ts: 0,
        operator: body.operator ?? 'operator',
        verdict: body.verdict,
        correctedAction: body.correctedAction,
        correctedPriority: body.correctedPriority,
        correctedResponderId: body.correctedResponderId ?? null,
        note: body.note,
      });
      res.json({ ok: true });
    } catch (err) {
      bad(res, err instanceof Error ? err.message : 'unknown incident');
    }
  }));

  // ── playbook ───────────────────────────────────────────────────────────
  router.post('/playbook/reflect', guard(async (_req, res) => {
    const proposal = await engine.reflectNow();
    res.json(proposal);
  }));

  router.post('/playbook/proposals/:id/apply', guard((req, res) => {
    const { accept, reject } = (req.body ?? {}) as { accept?: unknown; reject?: unknown };
    const a = Array.isArray(accept) ? accept.filter((x): x is string => typeof x === 'string') : [];
    const r = Array.isArray(reject) ? reject.filter((x): x is string => typeof x === 'string') : [];
    engine.applyProposal(String(req.params.id), a, r);
    res.json({ ok: true, accepted: a.length, rejected: r.length });
  }));

  router.post('/playbook/proposals/:id/dismiss', guard((req, res) => {
    engine.dismissProposal(String(req.params.id));
    res.json({ ok: true });
  }));

  router.post('/playbook/rules/:id/status', guard((req, res) => {
    const status = (req.body ?? {}).status as RuleStatus;
    if (!RULE_STATUSES.includes(status)) return bad(res, 'unknown rule status');
    engine.setRuleStatus(String(req.params.id), status);
    res.json({ ok: true });
  }));

  // ── evals ──────────────────────────────────────────────────────────────
  router.post('/evals/run', guard(async (req, res) => {
    const body = (req.body ?? {}) as { eventCount?: unknown; useLlm?: unknown };
    const count = Number(body.eventCount);
    if (!Number.isFinite(count) || count < 1) return bad(res, 'eventCount must be a positive number');
    const run = await engine.runEvalNow({
      eventCount: Math.min(2000, Math.floor(count)),
      useLlm: body.useLlm === true,
    });
    res.json(run);
  }));

  /**
   * The multi-world experiment. Separate from /evals/run because it answers a
   * different question: not "did learning win here" but "does it win in
   * general, and how sure are we".
   */
  router.post('/evals/experiment', guard(async (req, res) => {
    const body = (req.body ?? {}) as {
      eventCount?: unknown; seedCount?: unknown; useLlm?: unknown;
    };
    const count = Number(body.eventCount);
    const seeds = Number(body.seedCount);
    if (!Number.isFinite(count) || count < 1) return bad(res, 'eventCount must be a positive number');
    if (!Number.isFinite(seeds) || seeds < 2) return bad(res, 'seedCount must be at least 2');
    const exp = await engine.runExperimentNow({
      eventCount: Math.min(2000, Math.floor(count)),
      seedCount: Math.min(40, Math.floor(seeds)),
      useLlm: body.useLlm === true,
    });
    res.json(exp);
  }));

  router.post('/memory/reset', guard((_req, res) => {
    engine.resetMemory();
    res.json({ ok: true });
  }));

  return router;
}
