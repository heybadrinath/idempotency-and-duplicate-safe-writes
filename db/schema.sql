CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  service_id  UUID NOT NULL,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  tenant_id       UUID NOT NULL,
  operation       TEXT NOT NULL,
  key             TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  request_hash    TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'failed')),
  status_code     INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, operation, key),
  CHECK (state <> 'completed' OR (status_code IS NOT NULL AND response_body IS NOT NULL))
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

CREATE TABLE paging_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  incident_id UUID NOT NULL UNIQUE REFERENCES incidents(id),
  payload     JSONB NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
