-- Sessions de l'interface web (connexion GitHub). Seul le hash du jeton est stocké.
CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,
  login       TEXT NOT NULL,
  github_id   BIGINT NOT NULL,
  name        TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON sessions (expires_at);
