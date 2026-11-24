import { tx, type Db, type DbClient } from '../db/client.js';
import type { DeploymentTrigger } from '../db/schema.js';

export const JOBS_CHANNEL = 'catalyst_jobs';

export interface EnqueueInput {
  projectId: number;
  sha: string;
  commitMessage?: string | null;
  commitAuthor?: string | null;
  trigger: DeploymentTrigger;
  /** Rollback : image existante à réutiliser (les étapes fetch/build sont sautées). */
  imageTag?: string | null;
}

/**
 * Crée un déploiement + son job (plan §9.1). À appeler dans une transaction.
 * Les déploiements encore en file pour ce projet sont `superseded`, et un build
 * en cours reçoit une demande d'annulation (plan §9.4).
 */
export async function enqueueDeployment(c: DbClient, input: EnqueueInput): Promise<number> {
  await c.query(
    `UPDATE deployments SET status = 'superseded', finished_at = now()
      WHERE project_id = $1 AND status = 'queued'`,
    [input.projectId],
  );
  await c.query(`UPDATE jobs SET state = 'cancelled' WHERE project_id = $1 AND state = 'pending'`, [
    input.projectId,
  ]);
  await c.query(
    `UPDATE jobs SET cancel_requested = 'superseded'
      WHERE project_id = $1 AND state = 'running' AND cancel_requested IS NULL`,
    [input.projectId],
  );

  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO deployments (project_id, sha, commit_message, commit_author, trigger, image_tag)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      input.projectId,
      input.sha,
      input.commitMessage ?? null,
      input.commitAuthor ?? null,
      input.trigger,
      input.imageTag ?? null,
    ],
  );
  const deploymentId = rows[0]!.id;
  await c.query(`INSERT INTO jobs (deployment_id, project_id) VALUES ($1, $2)`, [deploymentId, input.projectId]);
  // Réveil immédiat du worker (délivré au COMMIT).
  await c.query(`SELECT pg_notify($1, $2)`, [JOBS_CHANNEL, String(deploymentId)]);
  return deploymentId;
}

/**
 * Enfile un déploiement seulement si `sha` n'a encore jamais été vu pour ce projet.
 * Webhook et poller passent par ici : le second à voir un SHA n'enfile rien (plan §8.2).
 * Retourne l'id du déploiement, ou null si le SHA était déjà connu.
 */
export async function enqueueIfNewSha(
  db: Db,
  projectId: number,
  head: { sha: string; message?: string | null; author?: string | null },
  trigger: 'webhook' | 'poll',
): Promise<number | null> {
  return tx(db, async (c) => {
    const updated = await c.query(
      `UPDATE projects SET last_seen_sha = $2, updated_at = now()
        WHERE id = $1 AND last_seen_sha IS DISTINCT FROM $2
        RETURNING id`,
      [projectId, head.sha],
    );
    if (updated.rowCount === 0) return null;
    return enqueueDeployment(c, {
      projectId,
      sha: head.sha,
      commitMessage: head.message,
      commitAuthor: head.author,
      trigger,
    });
  });
}
