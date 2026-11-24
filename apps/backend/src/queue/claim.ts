import { tx, type Db } from '../db/client.js';
import type { JobRow } from '../db/schema.js';

/** Prend le plus ancien job en attente, max 1 job en cours par projet (plan §9.2). */
export async function claimJob(db: Db): Promise<JobRow | null> {
  try {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs SET state = 'running', locked_at = now(), attempts = attempts + 1
        WHERE id = (
          SELECT j.id FROM jobs j
           WHERE j.state = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM jobs r
                WHERE r.project_id = j.project_id AND r.state = 'running'
             )
           ORDER BY j.created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING *`,
    );
    return rows[0] ?? null;
  } catch (err) {
    // Course entre deux workers sur le même projet : l'index unique partiel a tranché.
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

/** Rafraîchit `locked_at` : prouve que le worker qui tient le job est vivant. */
export async function heartbeat(db: Db, jobId: number): Promise<void> {
  await db.query(`UPDATE jobs SET locked_at = now() WHERE id = $1 AND state = 'running'`, [jobId]);
}

export const ORPHAN_AFTER_SECONDS = 120;

/** Nombre de tentatives au-delà duquel un déploiement interrompu n'est plus relancé. */
export const MAX_ATTEMPTS = 2;

export interface OrphanRecovery {
  /** Déploiements interrompus remis en file : ils reprennent automatiquement. */
  resumed: number;
  /** Déploiements interrompus trop souvent (ou devenus inutiles) : marqués en échec. */
  failed: number;
}

/**
 * Jobs `running` dont le worker ne donne plus signe de vie (crash, redémarrage de la plateforme).
 * Le déploiement reprend automatiquement (une fois) s'il n'a pas été remplacé entre-temps ;
 * sinon il passe en `failed`. Le site en ligne n'est jamais touché.
 * Au démarrage d'un process unique (ROLE=all), tous les jobs `running` sont orphelins (`olderThanSeconds = 0`).
 */
export async function recoverOrphans(db: Db, olderThanSeconds = ORPHAN_AFTER_SECONDS): Promise<OrphanRecovery> {
  return tx(db, async (c) => {
    const { rows: orphans } = await c.query<{ id: number; deployment_id: number; project_id: number; attempts: number; cancel_requested: string | null }>(
      `SELECT id, deployment_id, project_id, attempts, cancel_requested FROM jobs
        WHERE state = 'running' AND locked_at < now() - make_interval(secs => $1)
        FOR UPDATE`,
      [olderThanSeconds],
    );
    const result: OrphanRecovery = { resumed: 0, failed: 0 };
    for (const job of orphans) {
      // Un commit plus récent est déjà en file, ou une annulation était demandée : pas de reprise.
      const { rows: newer } = await c.query(
        `SELECT 1 FROM jobs WHERE project_id = $1 AND state = 'pending' AND id <> $2 LIMIT 1`,
        [job.project_id, job.id],
      );
      const { rows: stopped } = await c.query(`SELECT 1 FROM projects WHERE id = $1 AND (stopped OR NOT enabled)`, [
        job.project_id,
      ]);
      const resume = job.attempts < MAX_ATTEMPTS && newer.length === 0 && stopped.length === 0 && !job.cancel_requested;

      if (resume) {
        await c.query(`UPDATE jobs SET state = 'pending', locked_at = NULL WHERE id = $1`, [job.id]);
        const updated = await c.query(
          `UPDATE deployments SET status = 'queued', started_at = NULL, error = NULL
            WHERE id = $1 AND status NOT IN ('live', 'failed', 'cancelled', 'superseded', 'rolled_back')`,
          [job.deployment_id],
        );
        if (updated.rowCount) {
          await c.query(`INSERT INTO build_logs (deployment_id, stream, line) VALUES ($1, 'system', $2)`, [
            job.deployment_id,
            '↻ the platform restarted during the deployment: resuming automatically',
          ]);
          result.resumed++;
        } else {
          // Déploiement déjà terminé : le job n'a plus rien à faire.
          await c.query(`UPDATE jobs SET state = 'done' WHERE id = $1`, [job.id]);
        }
        continue;
      }

      await c.query(`UPDATE jobs SET state = 'failed' WHERE id = $1`, [job.id]);
      const reason =
        job.attempts >= MAX_ATTEMPTS
          ? 'interrupted twice by a platform restart: redeploy it manually'
          : newer.length
            ? 'interrupted by a platform restart (superseded by a newer commit)'
            : 'interrupted by a platform restart (site stopped or cancellation requested)';
      const updated = await c.query(
        `UPDATE deployments SET status = 'failed', finished_at = now(), error = $2
          WHERE id = $1 AND status NOT IN ('live', 'failed', 'cancelled', 'superseded', 'rolled_back')`,
        [job.deployment_id, reason],
      );
      if (updated.rowCount) result.failed++;
    }
    return result;
  });
}
