-- Site arrêté volontairement : conteneur stoppé (pas supprimé), pas de relance automatique,
-- auto-déploiement suspendu tant que le site est arrêté.
ALTER TABLE projects ADD COLUMN stopped BOOLEAN NOT NULL DEFAULT false;
