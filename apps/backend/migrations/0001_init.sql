-- Schéma initial (plan §6), avec quelques colonnes en plus :
--   projects.paused            : pause de l'auto-déploiement sans toucher à `enabled` (géré par projects.yml)
--   deployments.went_live_at   : date de mise en ligne (sert à choisir la cible d'un rollback)
--   jobs.cancel_requested      : demande d'annulation d'un job en cours ('superseded' | 'cancelled')

CREATE TABLE projects (
  id              SERIAL PRIMARY KEY,
  slug            TEXT UNIQUE NOT NULL,
  repo            TEXT NOT NULL,           -- owner/name
  branch          TEXT NOT NULL,
  config          JSONB NOT NULL,          -- copie validée du bloc YAML
  enabled         BOOLEAN NOT NULL DEFAULT true,
  paused          BOOLEAN NOT NULL DEFAULT false,
  last_seen_sha   TEXT,                    -- dernier SHA détecté (webhook ou poll)
  github_etag     TEXT,                    -- pour le polling conditionnel
  current_deployment_id INTEGER,           -- déploiement actuellement en ligne
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo, branch)
);

CREATE TYPE deployment_status AS ENUM (
  'queued', 'fetching', 'building', 'starting', 'healthchecking',
  'live', 'failed', 'cancelled', 'superseded', 'rolled_back'
);

CREATE TYPE deployment_trigger AS ENUM ('webhook', 'poll', 'manual', 'rollback');

CREATE TABLE deployments (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id),
  sha             TEXT NOT NULL,
  commit_message  TEXT,
  commit_author   TEXT,
  trigger         deployment_trigger NOT NULL,
  status          deployment_status NOT NULL DEFAULT 'queued',
  image_tag       TEXT,                    -- catalyst/<slug>:<sha12>
  container_name  TEXT,                    -- <slug>-<sha12>-<id>
  error           TEXT,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  went_live_at    TIMESTAMPTZ
);
CREATE INDEX ON deployments (project_id, queued_at DESC);

ALTER TABLE projects
  ADD CONSTRAINT fk_current_deployment
  FOREIGN KEY (current_deployment_id) REFERENCES deployments(id);

CREATE TABLE jobs (
  id              SERIAL PRIMARY KEY,
  deployment_id   INTEGER NOT NULL REFERENCES deployments(id),
  project_id      INTEGER NOT NULL REFERENCES projects(id),
  state           TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed | cancelled
  attempts        INTEGER NOT NULL DEFAULT 0,
  cancel_requested TEXT,                            -- NULL | superseded | cancelled
  locked_at       TIMESTAMPTZ,                      -- rafraîchi régulièrement par le worker (heartbeat)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON jobs (state, created_at);
-- Garantie en base : un seul job en cours par projet.
CREATE UNIQUE INDEX jobs_one_running_per_project ON jobs (project_id) WHERE state = 'running';

CREATE TABLE build_logs (
  id              BIGSERIAL PRIMARY KEY,
  deployment_id   INTEGER NOT NULL REFERENCES deployments(id),
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  stream          TEXT NOT NULL,           -- system | stdout | stderr
  line            TEXT NOT NULL
);
CREATE INDEX ON build_logs (deployment_id, id);

CREATE TABLE webhook_deliveries (            -- anti-rejeu + debug
  delivery_id     TEXT PRIMARY KEY,          -- header X-GitHub-Delivery
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  event           TEXT NOT NULL,
  repo            TEXT,
  accepted        BOOLEAN NOT NULL,
  reason          TEXT
);
CREATE INDEX ON webhook_deliveries (received_at);
