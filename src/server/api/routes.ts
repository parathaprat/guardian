/**
 * HTTP surface. One SSE stream plus a small command API.
 *
 * Everything validates defensively: a malformed POST returns 400, never a 500,
 * and never takes the dispatch loop down with it.
 */

import { Router, type Request, type Response } from 'express';
import type {
  AgentActionKind, EventType, OperatorFeedback, Priority, RuleStatus, SourceKind,
} from '../../shared/types';
import { ALL_EVENT_TYPES } from '../../shared/types';
import type { EngineGateway } from './gateway';
import { MAX_TRANSCRIPT } from '../agent/intake';
import { MAX_QUESTION } from '../agent/ask';

const ACTIONS: AgentActionKind[] = ['dispatch', 'escalate', 'monitor', 'suppress'];
const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];
const RULE_STATUSES: RuleStatus[] = ['proposed', 'active', 'rejected', 'retired'];
const SOURCE_KINDS: SourceKind[] = [
  'robot', 'fixed_sensor', 'guard_report', 'access_control', 'tenant_call',
];

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

export function createRouter(engine: EngineGateway): Router {
  const router = Router();

  router.get('/snapshot', guard(async (_req, res) => {
    res.json(await engine.snapshot());
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

    // Subscribe before fetching the snapshot (now async, may hit Postgres):
    // otherwise events published during that await would be lost. Buffer
    // until the snapshot is sent to preserve full-state-then-deltas ordering.
    const backlog: unknown[] = [];
    let opened = false;
    const unsubscribe = engine.subscribe((e) => {
      if (opened) send(e);
      else backlog.push(e);
    });

    void engine.snapshot()
      .then((snapshot) => {
        send({ type: 'snapshot', data: snapshot });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'toast', data: { level: 'error', message: `Snapshot unavailable: ${message}` } });
      })
      .finally(() => {
        opened = true;
        for (const e of backlog) send(e);
        backlog.length = 0;
      });

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  // ── simulation transport ───────────────────────────────────────────────
  router.post('/sim/start', guard(async (_req, res) => { await engine.start(); res.json({ ok: true }); }));
  router.post('/sim/pause', guard(async (_req, res) => { await engine.pause(); res.json({ ok: true }); }));

  router.post('/sim/speed', guard(async (req, res) => {
    const speed = Number((req.body ?? {}).speed);
    if (!Number.isFinite(speed) || speed <= 0) return bad(res, 'speed must be a positive number');
    await engine.setSpeed(speed);
    res.json({ ok: true, speed });
  }));

  router.post('/sim/seed', guard(async (req, res) => {
    const seed = Number((req.body ?? {}).seed);
    if (!Number.isInteger(seed)) return bad(res, 'seed must be an integer');
    await engine.reseed(seed);
    res.json({ ok: true, seed });
  }));

  router.post('/sim/inject', guard(async (req, res) => {
    const { type, zoneId } = (req.body ?? {}) as { type?: string; zoneId?: string };
    if (!type || !ALL_EVENT_TYPES.includes(type as EventType)) return bad(res, 'unknown event type');
    if (typeof zoneId !== 'string' || zoneId.length === 0) return bad(res, 'zoneId is required');
    await engine.injectEvent(type as EventType, zoneId);
    res.json({ ok: true });
  }));

  // ── operator feedback ──────────────────────────────────────────────────
  router.post('/incidents/:id/feedback', guard(async (req, res) => {
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
      await engine.feedback(String(req.params.id), {
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

  router.post('/playbook/proposals/:id/apply', guard(async (req, res) => {
    const { accept, reject } = (req.body ?? {}) as { accept?: unknown; reject?: unknown };
    const a = Array.isArray(accept) ? accept.filter((x): x is string => typeof x === 'string') : [];
    const r = Array.isArray(reject) ? reject.filter((x): x is string => typeof x === 'string') : [];
    await engine.applyProposal(String(req.params.id), a, r);
    res.json({ ok: true, accepted: a.length, rejected: r.length });
  }));

  router.post('/playbook/proposals/:id/dismiss', guard(async (req, res) => {
    await engine.dismissProposal(String(req.params.id));
    res.json({ ok: true });
  }));

  router.post('/playbook/rules/:id/status', guard(async (req, res) => {
    const status = (req.body ?? {}).status as RuleStatus;
    if (!RULE_STATUSES.includes(status)) return bad(res, 'unknown rule status');
    await engine.setRuleStatus(String(req.params.id), status);
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

  /** Separate from /evals/run: not "did learning win here" but "does it win in general". */
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

  router.post('/memory/reset', guard(async (_req, res) => {
    await engine.resetMemory();
    res.json({ ok: true });
  }));

  // ── language surfaces ──────────────────────────────────────────────────
  router.post('/intake/parse', guard(async (req, res) => {
    const transcript = String((req.body ?? {}).transcript ?? '').trim();
    if (transcript.length === 0) return bad(res, 'transcript is required');
    if (transcript.length > MAX_TRANSCRIPT) return bad(res, `transcript must be under ${MAX_TRANSCRIPT} characters`);
    res.json(await engine.parseIntake(transcript));
  }));

  /** The commit after /parse; takes confirmed fields, not a parse id, so an edited parse dispatches what's on screen. */
  router.post('/intake/dispatch', guard(async (req, res) => {
    const body = (req.body ?? {}) as {
      type?: string; zoneId?: string; description?: string; sourceKind?: string;
    };
    if (!body.type || !ALL_EVENT_TYPES.includes(body.type as EventType)) return bad(res, 'unknown event type');
    if (typeof body.zoneId !== 'string' || body.zoneId.length === 0) return bad(res, 'zoneId is required');
    const description = String(body.description ?? '').trim().slice(0, 240);
    if (description.length === 0) return bad(res, 'description is required');
    const sourceKind = SOURCE_KINDS.includes(body.sourceKind as SourceKind)
      ? (body.sourceKind as SourceKind)
      : 'guard_report';
    const { incidentId } = await engine.intakeDispatch({
      type: body.type as EventType, zoneId: body.zoneId, description, sourceKind,
    });
    res.json({ ok: true, incidentId });
  }));

  router.post('/handover/brief', guard(async (_req, res) => {
    res.json(await engine.briefNow());
  }));

  router.post('/ask', guard(async (req, res) => {
    const question = String((req.body ?? {}).question ?? '').trim();
    if (question.length === 0) return bad(res, 'question is required');
    if (question.length > MAX_QUESTION) return bad(res, `question must be under ${MAX_QUESTION} characters`);
    res.json(await engine.ask(question));
  }));

  return router;
}
