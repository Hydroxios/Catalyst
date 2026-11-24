import { siteUrl as siteUrlFor } from '../config/env.js';
import type { Ctx } from '../context.js';
import { tx } from '../db/client.js';
import type { CancelReason, DeploymentRow, DeploymentStatus, JobRow, ProjectRow } from '../db/schema.js';
import { imageExists, removeContainer } from '../docker/client.js';
import { containerName, imageTag, sha12 } from '../docker/spec.js';
import { setCommitStatus } from '../github/status.js';
import { captureFavicon } from '../favicon.js';
import { pruneProjectImages } from '../maintenance/cleanup.js';
import { notifyDeployment } from '../notify/discord.js';
import { heartbeat, MAX_ATTEMPTS } from '../queue/claim.js';
import { sleep } from '../utils/time.js';
import { CancelledError, StepError } from './errors.js';
import { DeploymentLogger } from './logger.js';
import { buildImage } from './steps/build.js';
import { fetchSource } from './steps/fetch.js';
import { waitHealthy } from './steps/healthcheck.js';
import { healthTimeout, readProjectEnv, startContainer } from './steps/run.js';
import { retireOldContainers } from './steps/switch.js';

const WATCH_INTERVAL_MS = 2_000;

/** Passe le déploiement en ligne en base (plan §10.6). Réessaie : la bascule a déjà eu lieu. */
async function markLive(ctx: Ctx, project: ProjectRow, deployment: DeploymentRow, jobId: number): Promise<void> {
  const previousStatus: DeploymentStatus = deployment.trigger === 'rollback' ? 'rolled_back' : 'superseded';
  for (let attempt = 1; ; attempt++) {
    try {
      await tx(ctx.db, async (c) => {
        await c.query(`SELECT id FROM projects WHERE id = $1 FOR UPDATE`, [project.id]);
        await c.query(
          `UPDATE deployments SET status = $3, finished_at = COALESCE(finished_at, now())
            WHERE project_id = $1 AND status = 'live' AND id <> $2`,
          [project.id, deployment.id, previousStatus],
        );
        await c.query(
          `UPDATE deployments SET status = 'live', error = NULL, finished_at = now(), went_live_at = now()
            WHERE id = $1`,
          [deployment.id],
        );
        await c.query(`UPDATE projects SET current_deployment_id = $2, stopped = false, updated_at = now() WHERE id = $1`, [
          project.id,
          deployment.id,
        ]);
        await c.query(`UPDATE jobs SET state = 'done' WHERE id = $1`, [jobId]);
      });
      return;
    } catch (err) {
      if (attempt >= 5) throw err;
      ctx.log.warn({ err, attempt }, 'could not record the go-live, retrying');
      await sleep(2_000 * attempt);
    }
  }
}

/**
 * Exécute un job de bout en bout (plan §10) :
 * fetching → building → starting → healthchecking → bascule → live.
 * En cas d'échec, le conteneur candidat est supprimé et la version en ligne n'est jamais touchée.
 */
export async function runDeployment(ctx: Ctx, job: JobRow, shutdown: AbortSignal): Promise<void> {
  const { db, docker, env } = ctx;
  const deployment = (await db.query<DeploymentRow>('SELECT * FROM deployments WHERE id = $1', [job.deployment_id]))
    .rows[0];
  const project = (await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [job.project_id])).rows[0];
  if (!deployment || !project) {
    await db.query(`UPDATE jobs SET state = 'failed' WHERE id = $1`, [job.id]);
    return;
  }
  if (deployment.status !== 'queued') {
    // Annulé entre la mise en file et la prise du job.
    await db.query(`UPDATE jobs SET state = 'cancelled' WHERE id = $1`, [job.id]);
    return;
  }

  const log = ctx.log.child({ project: project.slug, deploymentId: deployment.id });
  const logger = new DeploymentLogger(db, deployment.id, log);
  const cfg = project.config;
  const startedAt = Date.now();
  const tag = deployment.image_tag ?? imageTag(project.slug, deployment.sha);
  const name = containerName(project.slug, deployment.sha, deployment.id);
  const siteUrl = siteUrlFor(env, cfg.domains[0]!);
  const logsUrl = `${env.PUBLIC_URL}/#/deployments/${deployment.id}`;
  const isRollback = deployment.trigger === 'rollback';
  let commitMessage = deployment.commit_message;

  // Annulation : possible tant que le nouveau conteneur n'est pas lancé (plan §9.4).
  const cancel = new AbortController();
  let cancellable = true;
  let cancelReason: CancelReason | 'shutdown' | null = null;
  const requestCancel = (reason: CancelReason | 'shutdown') => {
    if (!cancellable || cancel.signal.aborted) return;
    cancelReason = reason;
    cancel.abort();
  };
  const checkCancel = () => {
    if (cancel.signal.aborted) throw new CancelledError(cancelReason ?? 'cancelled');
  };
  const onShutdown = () => requestCancel('shutdown');
  shutdown.addEventListener('abort', onShutdown);
  const watcher = setInterval(() => {
    void (async () => {
      try {
        await heartbeat(db, job.id);
        const { rows } = await db.query<{ cancel_requested: CancelReason | null }>(
          'SELECT cancel_requested FROM jobs WHERE id = $1',
          [job.id],
        );
        const reason = rows[0]?.cancel_requested;
        if (reason) requestCancel(reason);
      } catch (err) {
        log.warn({ err }, 'heartbeat failed');
      }
    })();
  }, WATCH_INTERVAL_MS);

  const setStatus = (status: DeploymentStatus) =>
    db.query('UPDATE deployments SET status = $2 WHERE id = $1', [deployment.id, status]);

  let candidateStarted = false;
  let switched = false;
  try {
    await db.query('UPDATE deployments SET started_at = now(), container_name = $2 WHERE id = $1', [
      deployment.id,
      name,
    ]);
    void setCommitStatus(ctx, project.repo, deployment.sha, 'pending', 'Deploying', logsUrl);

    if (isRollback) {
      logger.system(`↩ rollback to ${sha12(deployment.sha)} (image ${tag})`);
      if (!(await imageExists(docker, tag))) {
        throw new StepError(
          `image ${tag} was removed, a full redeploy is needed (POST /api/projects/${project.slug}/deploy with { "sha": "${deployment.sha}" })`,
        );
      }
    } else {
      await setStatus('fetching');
      logger.system(`▶ fetching ${sha12(deployment.sha)} (${project.repo}@${project.branch})`);
      const src = await fetchSource(ctx, project, deployment.sha, logger, cancel.signal);
      if (!deployment.commit_message && (src.commitMessage || src.commitAuthor)) {
        commitMessage = src.commitMessage;
        await db.query(
          'UPDATE deployments SET commit_message = COALESCE(commit_message, $2), commit_author = COALESCE(commit_author, $3) WHERE id = $1',
          [deployment.id, src.commitMessage, src.commitAuthor],
        );
      }
      checkCancel();

      await setStatus('building');
      logger.system(`▶ building ${tag}`);
      const buildStart = Date.now();
      await buildImage(ctx, project, deployment.sha, tag, src.dir, logger, cancel.signal);
      await db.query('UPDATE deployments SET image_tag = $2 WHERE id = $1', [deployment.id, tag]);
      logger.system(`✔ build finished in ${Math.round((Date.now() - buildStart) / 1000)}s`);
      checkCancel();
    }

    // À partir d'ici on va jusqu'au bout : plus d'annulation.
    cancellable = false;
    await setStatus('starting');
    const runtimeEnv = readProjectEnv(ctx, project.slug);
    for (const kv of runtimeEnv) logger.addSecret(kv.slice(kv.indexOf('=') + 1));
    const mode = cfg.healthcheck.mode;
    const timeoutSeconds = healthTimeout(ctx, cfg);
    const startOpts = { sha: deployment.sha, deploymentId: deployment.id, image: tag, name, env: runtimeEnv };

    logger.system(`▶ starting container ${name}${mode === 'docker' ? '' : ' (not routed)'}`);
    candidateStarted = true;
    await startContainer(ctx, cfg, { ...startOpts, routed: mode === 'docker' });

    await setStatus('healthchecking');
    await waitHealthy(ctx, cfg, name, logger, { useDockerHealth: mode === 'docker', timeoutSeconds });

    if (mode === 'worker') {
      // Les labels Docker ne sont pas modifiables : on recrée le conteneur, routé cette fois (plan §12, repli).
      logger.system('▶ recreating the container with Traefik routing');
      await removeContainer(docker, name, 10);
      await startContainer(ctx, cfg, { ...startOpts, routed: true });
      await waitHealthy(ctx, cfg, name, logger, { useDockerHealth: false, timeoutSeconds });
    }

    await retireOldContainers(ctx, project.slug, name, logger);
    switched = true;
    await markLive(ctx, project, deployment, job.id);

    const durationMs = Date.now() - startedAt;
    logger.system(`✔ live: ${siteUrl} (${Math.round(durationMs / 1000)}s)`);
    await setCommitStatus(ctx, project.repo, deployment.sha, 'success', 'Deployed', siteUrl);
    await notifyDeployment(ctx, {
      ok: true,
      slug: project.slug,
      repo: project.repo,
      sha: deployment.sha,
      commitMessage,
      durationMs,
      url: siteUrl,
      rollback: isRollback,
    });
    await pruneProjectImages(ctx, project).catch((err) => log.warn({ err }, 'image cleanup failed'));
    // Favicon du site (si c'est un site HTML) pour l'interface ; sans incidence sur le déploiement.
    void captureFavicon(ctx, project, { ...deployment, container_name: name });
  } catch (err) {
    if (candidateStarted && !switched) {
      await removeContainer(docker, name, 5).catch((e) => log.error({ err: e }, 'could not remove the candidate container'));
    }

    const cancelled = err instanceof CancelledError || (cancel.signal.aborted && cancelReason !== null);
    if (cancelled) {
      // (cast : TypeScript ne voit pas l'affectation faite dans requestCancel)
      const reason = (cancelReason as CancelReason | 'shutdown' | null) ?? 'cancelled';
      if (reason === 'shutdown') {
        // Arrêt propre de la plateforme : le déploiement est remis en file et reprendra au redémarrage
        // (dans la limite de MAX_ATTEMPTS, comme pour un arrêt brutal).
        logger.system('⏸ the platform is shutting down: the deployment will resume automatically on restart');
        if (job.attempts < MAX_ATTEMPTS) {
          await db.query(`UPDATE deployments SET status = 'queued', started_at = NULL, error = NULL WHERE id = $1`, [
            deployment.id,
          ]);
          await db.query(`UPDATE jobs SET state = 'pending', locked_at = NULL WHERE id = $1`, [job.id]);
          return;
        }
      }
      const message = new CancelledError(reason).message;
      const status: DeploymentStatus =
        reason === 'superseded' ? 'superseded' : reason === 'shutdown' ? 'failed' : 'cancelled';
      logger.system(`■ ${message}`);
      await db.query('UPDATE deployments SET status = $2, error = $3, finished_at = now() WHERE id = $1', [
        deployment.id,
        status,
        message,
      ]);
      await db.query(`UPDATE jobs SET state = $2 WHERE id = $1`, [
        job.id,
        reason === 'shutdown' ? 'failed' : 'cancelled',
      ]);
      await setCommitStatus(ctx, project.repo, deployment.sha, 'error', `Deployment ${message}`, logsUrl);
      return;
    }

    const message = (err instanceof StepError ? err.message : `internal error: ${(err as Error).message}`).slice(
      0,
      1000,
    );
    if (!(err instanceof StepError)) log.error({ err }, 'deployment failed');
    logger.system(`✖ ${message}`);
    if (switched) {
      // La nouvelle version sert déjà le trafic ; seule l'écriture en base a échoué.
      logger.system('⚠ the new version is live but its status could not be recorded');
    }
    await db
      .query('UPDATE deployments SET status = $2, error = $3, finished_at = now() WHERE id = $1', [
        deployment.id,
        'failed',
        message,
      ])
      .catch((e) => log.error({ err: e }, 'could not update the status'));
    await db.query(`UPDATE jobs SET state = 'failed' WHERE id = $1`, [job.id]).catch(() => {});
    await setCommitStatus(ctx, project.repo, deployment.sha, 'failure', message, logsUrl);
    await notifyDeployment(ctx, {
      ok: false,
      slug: project.slug,
      repo: project.repo,
      sha: deployment.sha,
      commitMessage,
      durationMs: Date.now() - startedAt,
      url: logsUrl,
      error: message,
      rollback: isRollback,
    });
  } finally {
    clearInterval(watcher);
    shutdown.removeEventListener('abort', onShutdown);
    await logger.close();
  }
}
