/**
 * Semantic precedent: matches incidents on description text via embeddings,
 * complementing the structured similarity in `precedent.ts`. The eval harness
 * never uses this (retrieval there must stay deterministic and free), so
 * `AgentContext.semantic` is optional and everything degrades gracefully when
 * the embed service is unavailable. See DECISIONS.md.
 */

import type { Incident, SecurityEvent } from '../../shared/types';

export interface SemanticNeighbour {
  incidentId: string;
  /** Cosine similarity in 0..1, already normalised by the embedding service. */
  similarity: number;
}

export interface SemanticIndex {
  /** Called once, when an incident resolves. */
  index(runId: string, incident: Incident): Promise<void>;
  similar(runId: string, event: SecurityEvent, k: number): Promise<SemanticNeighbour[]>;
}

/** Everything an incident says, in the order a reader would weigh it. */
function incidentText(i: Incident): string {
  return [
    i.event.description,
    i.event.type.replace(/_/g, ' '),
    i.decision?.rationale ?? '',
  ].filter(Boolean).join('. ');
}

function eventText(e: SecurityEvent): string {
  return `${e.description}. ${e.type.replace(/_/g, ' ')}`;
}

export interface EmbedClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Stop calling after this many consecutive failures. */
  breakerAfter?: number;
}

/**
 * HTTP client for the FastAPI embedding service, with a circuit breaker: after
 * a few consecutive failures it stops trying for a minute so a dead service
 * doesn't add full-timeout latency to every dispatch.
 */
export class EmbedClient {
  private failures = 0;
  private openUntil = 0;

  constructor(private opts: EmbedClientOptions) {}

  private get breakerAfter(): number { return this.opts.breakerAfter ?? 3; }

  get available(): boolean {
    return Date.now() >= this.openUntil;
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    if (!this.available || texts.length === 0) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 8_000);
    try {
      const res = await fetch(`${this.opts.baseUrl}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`embed service returned ${res.status}`);
      const body = await res.json() as { vectors: number[][] };
      this.failures = 0;
      return body.vectors;
    } catch {
      this.failures += 1;
      if (this.failures >= this.breakerAfter) {
        this.openUntil = Date.now() + 60_000;
        this.failures = 0;
        console.error('[semantic] embedding service unreachable, '
          + 'falling back to structured precedent for 60s');
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Vectors live in the `incidents.embedding` column (pgvector), so
 * nearest-neighbour is a join-free scan against rows already stored, no
 * separate vector database or staleness risk.
 */
export interface VectorStore {
  saveEmbedding(runId: string, incidentId: string, vector: number[]): Promise<void>;
  nearest(runId: string, vector: number[], k: number): Promise<SemanticNeighbour[]>;
}

export class PgVectorIndex implements SemanticIndex {
  constructor(private embed: EmbedClient, private store: VectorStore) {}

  async index(runId: string, incident: Incident): Promise<void> {
    const text = incidentText(incident).trim();
    if (!text) return;
    const vectors = await this.embed.embed([text]);
    const vector = vectors?.[0];
    if (!vector) return;
    await this.store.saveEmbedding(runId, incident.id, vector);
  }

  async similar(runId: string, event: SecurityEvent, k: number): Promise<SemanticNeighbour[]> {
    const vectors = await this.embed.embed([eventText(event)]);
    const vector = vectors?.[0];
    if (!vector) return [];
    return this.store.nearest(runId, vector, k);
  }
}
