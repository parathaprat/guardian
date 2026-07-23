"""
guard[ai]n embedding service.

The one part of this system written in Python, and it is worth being explicit
about why, because "we should use FastAPI somewhere" is not a reason.

The rest of the product is TypeScript and stays TypeScript: the domain types are
shared between client and server, ground-truth containment is enforced at the
type level across that boundary, and the determinism the eval harness depends on
lives in the simulator. Rewriting any of that in Python would risk the project's
central claim in exchange for nothing.

Embedding text is genuinely different. It wants sentence-transformers, torch and
a model cache, none of which have a good story in Node, and it is naturally a
separate scaling unit: it is CPU-bound where the API is IO-bound, and it can be
restarted, scaled or swapped for a hosted embedding endpoint without the console
noticing. So it gets its own service and owns exactly one job.

What it is for: `precedent.ts` matches past incidents on hand-tuned structured
weights (type, zone, hour, source) and has no notion of what an incident
*said*. Since radio intake landed, descriptions are free text written by a human
under stress, and "have we seen this before" is the question a security operator
actually asks. Cosine similarity over descriptions answers it in a way weighted
feature matching cannot.

Honest limitation, stated here rather than discovered by a reviewer: the
simulator writes descriptions from templates, so semantic search shows little
lift on synthetic data. It earns its place on radio-intake text and would earn it
on real alarm feeds. The eval harness deliberately does not use it, both for that
reason and because a network call per lookup would make a 2 second replay a 20
minute one.
"""

from __future__ import annotations

import os
import time
from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get("EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
# Must match `vector(384)` in the schema. Asserted at boot rather than
# discovered as a Postgres error on the first insert.
EXPECTED_DIMS = int(os.environ.get("EMBED_DIMS", "384"))
MAX_BATCH = 256
MAX_CHARS = 2000

app = FastAPI(
    title="guard[ai]n embeddings",
    version="1.0.0",
    summary="Sentence embeddings for semantic precedent retrieval.",
)

_model: SentenceTransformer | None = None
_loaded_at: float | None = None


def model() -> SentenceTransformer:
    """
    Loaded lazily on first use, not at import.

    Uvicorn's worker would otherwise sit unresponsive for the length of a model
    download while an orchestrator's health check fails and restarts it, which
    is a loop that never converges on a cold cache.
    """
    global _model, _loaded_at
    if _model is None:
        started = time.time()
        _model = SentenceTransformer(MODEL_NAME)
        dims = _model.get_sentence_embedding_dimension()
        if dims != EXPECTED_DIMS:
            raise RuntimeError(
                f"{MODEL_NAME} produces {dims} dimensions but the schema declares "
                f"{EXPECTED_DIMS}. Change EMBED_DIMS and the vector(N) column together."
            )
        _loaded_at = time.time() - started
    return _model


class EmbedRequest(BaseModel):
    texts: List[str] = Field(..., min_length=1, max_length=MAX_BATCH)


class EmbedResponse(BaseModel):
    model: str
    dims: int
    vectors: List[List[float]]
    took_ms: int


@app.get("/health")
def health() -> dict:
    """
    Reports ready before the model is loaded, deliberately.

    The service can accept traffic; the first request pays the load. Reporting
    unhealthy during a cold start is what causes the restart loop described in
    `model()`.
    """
    return {
        "ok": True,
        "model": MODEL_NAME,
        "dims": EXPECTED_DIMS,
        "loaded": _model is not None,
        "load_seconds": round(_loaded_at, 2) if _loaded_at else None,
    }


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    started = time.time()

    # Truncated rather than rejected: an over-long incident description is a
    # real thing that should still be searchable, and the first two thousand
    # characters carry the meaning.
    texts = [t[:MAX_CHARS] for t in req.texts]
    if not any(t.strip() for t in texts):
        raise HTTPException(status_code=422, detail="every text was empty")

    # Normalised on the way out, so the caller can use cosine distance in
    # Postgres without renormalising per query.
    vectors = model().encode(
        texts,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )

    return EmbedResponse(
        model=MODEL_NAME,
        dims=EXPECTED_DIMS,
        vectors=[v.tolist() for v in vectors],
        took_ms=int((time.time() - started) * 1000),
    )
