/**
 * `POST /api/v1/events`, the boundary a real alarm source (e.g. Verkada,
 * Genetec) would arrive through: versioned, HMAC-authenticated per source,
 * idempotent under at-least-once redelivery, and translating vendor payloads
 * rather than trusting them. See DECISIONS.md Decision 8.
 */

import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ALL_EVENT_TYPES } from '../../shared/types';
import type { EventType } from '../../shared/types';
import type { Repository } from '../contracts';
import type { EngineGateway } from './gateway';

/** The vendor-facing payload. Deliberately not `SecurityEvent`, which carries fields (id, sim timestamp) only the simulator can produce. */
export interface IngestEvent {
  /** Zone id or zone code. Codes are what humans configure, so both are accepted. */
  zone: string;
  type: string;
  /** ISO 8601 or epoch ms. Recorded but not trusted as the sim clock. */
  observed_at?: string | number;
  /** 0..1 from the device. Deliberately not trusted; the agent learns to discount it. */
  confidence?: number;
  description?: string;
  source?: { kind?: string; id?: string; name?: string };
  metadata?: Record<string, string | number | boolean>;
}

const MAX_BATCH = 50;

function fail(res: Response, status: number, error: string, extra: object = {}): void {
  res.status(status).json({ error, ...extra });
}

/** `timingSafeEqual` throws on a length mismatch, which would itself leak timing info, so lengths are checked first. */
function signatureValid(secret: string, raw: string, header: string | undefined): boolean {
  if (!header) return false;
  const provided = header.startsWith('sha256=') ? header.slice(7) : header;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

export function createIngestRouter(engine: EngineGateway, repo: Repository): Router {
  const router = Router();
  const secret = process.env.GUARDAIN_INGEST_SECRET?.trim() ?? '';

  /** Lets an integrator discover the vocabulary rather than guess and find out from a 422. */
  router.get('/events/schema', (_req, res) => {
    res.json({
      version: 'v1',
      eventTypes: ALL_EVENT_TYPES,
      sourceKinds: ['robot', 'fixed_sensor', 'guard_report', 'access_control', 'tenant_call'],
      signature: {
        header: 'X-Guardain-Signature',
        algorithm: 'HMAC-SHA256 over the raw request body, hex, optionally prefixed "sha256="',
        required: secret.length > 0,
      },
      idempotency: {
        header: 'Idempotency-Key',
        required: false,
        note: 'Strongly recommended. Redelivery with the same key is acknowledged, not re-raised.',
      },
      limits: { maxBatch: MAX_BATCH },
    });
  });

  router.post('/events', (req: Request, res: Response) => {
    void (async () => {
      // Signature checked before any parsing of an unauthenticated body. Unset secret means an open endpoint (local demo).
      if (secret) {
        const raw = JSON.stringify(req.body ?? {});
        if (!signatureValid(secret, raw, req.header('x-guardain-signature') ?? undefined)) {
          return fail(res, 401, 'invalid or missing X-Guardain-Signature');
        }
      }

      const body = (req.body ?? {}) as { events?: unknown } & IngestEvent;
      const batch: IngestEvent[] = Array.isArray(body.events)
        ? (body.events as IngestEvent[])
        : [body];

      if (batch.length === 0) return fail(res, 400, 'no events in payload');
      if (batch.length > MAX_BATCH) {
        return fail(res, 413, `at most ${MAX_BATCH} events per request`, { received: batch.length });
      }

      const key = req.header('idempotency-key')?.trim();
      if (key) {
        const claimed = await repo.claimIngestKey(key, batch[0]?.zone ?? 'batch');
        if (!claimed) {
          // 200, not 409: the caller did nothing wrong, and treating a retry as an error invites a retry storm.
          return res.status(200).json({ ok: true, duplicate: true, accepted: 0 });
        }
      }

      const snapshot = await engine.snapshot();
      const zones = snapshot.world.zones;
      const accepted: Array<{ zone: string; type: string }> = [];
      const rejected: Array<{ index: number; reason: string }> = [];

      for (const [index, raw] of batch.entries()) {
        const type = String(raw?.type ?? '').trim();
        if (!ALL_EVENT_TYPES.includes(type as EventType)) {
          rejected.push({ index, reason: `unknown event type "${type}"` });
          continue;
        }
        const wanted = String(raw?.zone ?? '').trim();
        const zone = zones.find((z) => z.id === wanted)
          ?? zones.find((z) => z.code.toLowerCase() === wanted.toLowerCase());
        if (!zone) {
          rejected.push({ index, reason: `unknown zone "${wanted}"` });
          continue;
        }
        await engine.injectEvent(type as EventType, zone.id);
        accepted.push({ zone: zone.code, type });
      }

      // 422 only when the whole batch was unusable; a partial batch is a 202 listing what was dropped.
      if (accepted.length === 0) {
        return fail(res, 422, 'no event in the payload could be accepted', { rejected });
      }

      res.status(202).json({ ok: true, accepted: accepted.length, events: accepted, rejected });
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.status(500).json({ error: message });
    });
  });

  return router;
}
