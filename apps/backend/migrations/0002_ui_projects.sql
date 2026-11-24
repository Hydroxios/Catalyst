-- Projets gérables depuis l'interface web.
--   managed_by = 'file' : défini dans projects.yml (lecture seule dans l'UI, resynchronisé au démarrage)
--   managed_by = 'ui'   : créé depuis l'interface, la base est la source de vérité
ALTER TABLE projects ADD COLUMN managed_by TEXT NOT NULL DEFAULT 'file';
ALTER TABLE projects ALTER COLUMN managed_by SET DEFAULT 'ui';
