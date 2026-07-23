-- guard[ai]n schema.
--
-- Two shaping decisions worth stating, because both are the kind of thing a
-- reviewer should be able to argue with:
--
-- 1. Deep, read-whole structures (a decision, a trace, a dispatch record) are
--    `jsonb` columns rather than normalised tables. They are written once,
--    always read as a unit, and their shape is already pinned by
--    `src/shared/types.ts`, so normalising them would buy joins nobody runs and
--    a migration every time the agent gains a field. Anything actually
--    *queried* (zone, type, outcome, timestamps) is a real column with an
--    index.
--
-- 2. `org_id` is on every row from the first migration. Physical security is
--    inherently multi-customer, and retrofitting tenancy onto a schema that
--    grew up single-tenant is one of the more miserable jobs in software. It
--    costs a column now and it is the difference between a demo and something
--    that could hold two customers.
--
-- Idempotent: safe to run on every boot.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── tenancy ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO orgs (id, name) VALUES ('demo', 'Demo Portfolio')
  ON CONFLICT (id) DO NOTHING;

-- Keys are stored hashed. The plaintext is shown once, at creation, and never
-- again, which is the only version of this that is not a liability.
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

-- ── a run: one seeded world instance ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  seed        BIGINT NOT NULL,
  controls    JSONB,
  -- The worker's engine status, written alongside controls.
  --
  -- The API process has no agent, so calling `engineStatus()` there reports its
  -- own absent one: a stack running Gemini rendered "REASONER" in the header.
  -- The worker is the only process that knows, so it is the one that records it.
  engine      JSONB,
  metrics     JSONB,
  curve       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, seed)
);

-- ── the alarm stream ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_id          TEXT NOT NULL,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  sim_ts            DOUBLE PRECISION NOT NULL,
  site_id           TEXT NOT NULL,
  zone_id           TEXT NOT NULL,
  type              TEXT NOT NULL,
  source_kind       TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  description       TEXT NOT NULL,
  sensor_confidence REAL NOT NULL,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, event_id)
);

CREATE INDEX IF NOT EXISTS events_run_ts_idx ON events (run_id, sim_ts DESC);
CREATE INDEX IF NOT EXISTS events_zone_type_idx ON events (run_id, zone_id, type);

-- ── incidents ──────────────────────────────────────────────────────────────
--
-- `revealed_truth` lives here because the ledger is written *after* resolution
-- and is what the operator is shown. It is never joined into anything the agent
-- reads: containment is enforced in the engine, and this column exists so the
-- right/wrong verdict survives a restart.

CREATE TABLE IF NOT EXISTS incidents (
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  incident_id         TEXT NOT NULL,
  org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at_sim      DOUBLE PRECISION NOT NULL,
  status              TEXT NOT NULL,
  engine              TEXT NOT NULL,
  outcome             TEXT,
  resolved_at_sim     DOUBLE PRECISION,
  decision_latency_ms INTEGER,
  zone_id             TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  event               JSONB NOT NULL,
  decision            JSONB,
  trace               JSONB NOT NULL DEFAULT '[]'::jsonb,
  dispatch            JSONB,
  feedback            JSONB,
  revealed_truth      JSONB,
  linked_incident_ids TEXT[] NOT NULL DEFAULT '{}',
  -- Phase 4. Null until the embedding service has seen this incident; the
  -- precedent lookup falls back to structured similarity while it is null, so
  -- the service being down degrades retrieval rather than breaking it.
  embedding           vector(384),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, incident_id)
);

CREATE INDEX IF NOT EXISTS incidents_run_created_idx ON incidents (run_id, created_at_sim DESC);
CREATE INDEX IF NOT EXISTS incidents_open_idx ON incidents (run_id) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS incidents_zone_type_idx ON incidents (run_id, zone_id, event_type);

-- IVFFlat needs rows before it can build meaningful lists, and an empty index
-- is worse than none. Created here anyway so the shape is declared; Postgres
-- will simply not use it until the table has content.
CREATE INDEX IF NOT EXISTS incidents_embedding_idx
  ON incidents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- ── learned memory ─────────────────────────────────────────────────────────
--
-- One row per run holding the whole learned state. Snapshot rather than
-- row-per-cell because it is written as a unit by a write-behind flush and read
-- as a unit on boot; per-cell rows would mean hundreds of upserts per flush to
-- support a query nobody makes.

CREATE TABLE IF NOT EXISTS memory_snapshots (
  run_id      TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  calibration JSONB NOT NULL DEFAULT '[]'::jsonb,
  responders  JSONB NOT NULL DEFAULT '[]'::jsonb,
  playbook    JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposals   JSONB NOT NULL DEFAULT '[]'::jsonb,
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── briefings ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS briefings (
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  briefing_id  TEXT NOT NULL,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at_sim DOUBLE PRECISION NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, briefing_id)
);

CREATE INDEX IF NOT EXISTS briefings_run_idx ON briefings (run_id, created_at DESC);

-- ── ingest idempotency ─────────────────────────────────────────────────────
--
-- Every real alarm source delivers at-least-once. A duplicate POST is a normal
-- Tuesday, not an error, so the key is claimed transactionally and a second
-- claim returns the original event id rather than raising.

CREATE TABLE IF NOT EXISTS ingest_keys (
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, idempotency_key)
);

-- Old keys are not interesting forever; a real deployment would prune on a
-- schedule. Index supports that sweep.
CREATE INDEX IF NOT EXISTS ingest_keys_age_idx ON ingest_keys (created_at);

-- ── migrations ─────────────────────────────────────────────────────────────
--
-- `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
-- corrections to a shipped column live here. Each is guarded by a catalogue
-- check rather than run blind: an unguarded ALTER rewrites the table on every
-- boot, which is fine at ten rows and an outage at ten million.
--
-- A real deployment would use numbered migration files with a version table.
-- This is the honest small version of that: idempotent, ordered, and readable.

-- 002. Engine status, so the API can report the worker's engine rather than its own.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS engine JSONB;

-- 001. Simulated timestamps are fractional milliseconds, not integers.
--      Declared BIGINT originally, which rejected every write with
--      `invalid input syntax for type bigint: "1784597774350.7512"`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'events' AND column_name = 'sim_ts' AND data_type = 'bigint'
  ) THEN
    ALTER TABLE events ALTER COLUMN sim_ts TYPE DOUBLE PRECISION;
    ALTER TABLE incidents ALTER COLUMN created_at_sim TYPE DOUBLE PRECISION;
    ALTER TABLE incidents ALTER COLUMN resolved_at_sim TYPE DOUBLE PRECISION;
    ALTER TABLE briefings ALTER COLUMN created_at_sim TYPE DOUBLE PRECISION;
    RAISE NOTICE 'migrated sim timestamp columns to double precision';
  END IF;
END $$;
