import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Ctx } from '../context.js';
import { tx } from '../db/client.js';
import {
  TERMINAL_STATUSES,
  type BuildLogRow,
  type DeploymentRow,
  type ProjectRow,
} from '../db/schema.js';
import { imageExists } from '../docker/client.js';
import { getBranchHead } from '../github/client.js';
import { RepoAccessError } from '../github/service.js';
import { enqueueDeployment } from '../queue/enqueue.js';
import { sleep } from '../utils/time.js';
import { authenticate, isSameOrigin } from '../auth/session.js';
import { startLiveContainer, stopProjectContainers } from '../reconcile.js';
import { adminRoutes } from './admin.js';
import { HttpError } from './errors.js';

async function getProject(ctx: Ctx, slug: string): Promise<ProjectRow> {
  const { rows } = await ctx.db.query<ProjectRow>('SELECT * FROM projects WHERE slug = $1', [slug]);
  if (!rows[0]) throw new HttpError(404, `unknown project: ${slug}`);
  return rows[0];
}

async function getDeployment(ctx: Ctx, id: number): Promise<DeploymentRow> {
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid id');
  const { rows } = await ctx.db.query<DeploymentRow>('SELECT * FROM deployments WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, `unknown deployment: ${id}`);
  return rows[0];
}

function publicProject(p: ProjectRow) {
  return {
    slug: p.slug,
    repo: p.repo,
    branch: p.branch,
    domains: p.config.domains,
    enabled: p.enabled,
    paused: p.paused,
    stopped: p.stopped,
    managedBy: p.managed_by,
    config: p.config,
    lastSeenSha: p.last_seen_sha,
    currentDeploymentId: p.current_deployment_id,
  };
}

async function streamLogs(ctx: Ctx, deploymentId: number, after: number, reply: FastifyReply): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let closed = false;
  res.on('close', () => (closed = true));

  let lastId = after;
  let terminalSince: number | null = null;
  let lastPing = Date.now();
  while (!closed) {
    const { rows: dep } = await ctx.db.query<{ status: DeploymentRow['status'] }>(
      'SELECT status FROM deployments WHERE id = $1',
      [deploymentId],
    );
    const status = dep[0]?.status;
    const { rows } = await ctx.db.query<BuildLogRow>(
      'SELECT * FROM build_logs WHERE deployment_id = $1 AND id > $2 ORDER BY id LIMIT 1000',
      [deploymentId, lastId],
    );
    for (const row of rows) {
      res.write(`id: ${row.id}\nevent: log\ndata: ${JSON.stringify({ ts: row.ts, stream: row.stream, line: row.line })}\n\n`);
      lastId = Number(row.id);
    }
    if (rows.length === 1000) continue;

    if (status && TERMINAL_STATUSES.includes(status)) {
      // Laisse le temps au dernier lot de logs d'arriver en base.
      terminalSince ??= Date.now();
      if (rows.length === 0 && Date.now() - terminalSince > 2_000) {
        res.write(`event: end\ndata: ${JSON.stringify({ status })}\n\n`);
        break;
      }
    }
    if (Date.now() - lastPing > 15_000) {
      res.write(': ping\n\n');
      lastPing = Date.now();
    }
    await sleep(1_000);
  }
  res.end();
}

/** Routes /api/* (plan §15), toutes protégées par `Authorization: Bearer <ADMIN_TOKEN>`. */
export async function apiRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    const user = await authenticate(ctx, req);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    if (user.via === 'session' && !['GET', 'HEAD'].includes(req.method) && !isSameOrigin(ctx, req)) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof RepoAccessError) return reply.code(400).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message });
    // Erreur renvoyée par l'API GitHub (Octokit) : on la remonte telle quelle, c'est souvent un souci de token.
    const ghStatus = (err as { status?: unknown }).status;
    if (typeof ghStatus === 'number' && (err as { request?: unknown }).request) {
      req.log.warn({ err }, 'GitHub error');
      const hint =
        ghStatus === 401
          ? 'GitHub access denied (invalid token or GitHub App)'
          : ghStatus === 403
            ? 'access denied by GitHub (token permissions or quota)'
            : `GitHub responded ${ghStatus}`;
      return reply.code(502).send({ error: `${hint} : ${(err as Error).message}` });
    }
    req.log.error({ err }, 'API error');
    return reply.code(500).send({ error: 'internal error' });
  });

  await adminRoutes(app, ctx);

  app.get('/projects', async () => {
    type Recent = { id: number; status: DeploymentRow['status']; queued_at: string };
    const { rows } = await ctx.db.query<
      ProjectRow & { live: DeploymentRow | null; latest: DeploymentRow | null; recent: Recent[] | null }
    >(
      `SELECT p.*,
              to_jsonb(live) AS live,
              (SELECT to_jsonb(d) FROM deployments d
                WHERE d.project_id = p.id AND (d.status <> 'superseded' OR d.went_live_at IS NOT NULL)
                ORDER BY d.id DESC LIMIT 1) AS latest,
              -- 12 derniers déploiements réellement lancés (du plus ancien au plus récent), pour l'historique
              (SELECT jsonb_agg(r ORDER BY r.id) FROM (
                 SELECT id, status, queued_at FROM deployments d
                  WHERE d.project_id = p.id AND (d.status <> 'superseded' OR d.went_live_at IS NOT NULL)
                  ORDER BY id DESC LIMIT 12) r) AS recent
         FROM projects p
         LEFT JOIN deployments live ON live.id = p.current_deployment_id
        WHERE p.enabled OR p.managed_by = 'file'
        ORDER BY p.slug`,
    );
    return rows.map((p) => ({ ...publicProject(p), live: p.live, latest: p.latest, recent: p.recent ?? [] }));
  });

  /** Activité récente, tous projets confondus (fil du tableau de bord). */
  app.get<{ Querystring: { limit?: string } }>('/deployments', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 15) || 15, 1), 100);
    const { rows } = await ctx.db.query(
      `SELECT d.id, d.sha, d.status, d.trigger, d.commit_message, d.commit_author, d.error,
              d.queued_at, d.started_at, d.finished_at, p.slug, p.repo
         FROM deployments d JOIN projects p ON p.id = d.project_id
        WHERE (p.enabled OR p.managed_by = 'file') AND (d.status <> 'superseded' OR d.went_live_at IS NOT NULL)
        ORDER BY d.id DESC LIMIT $1`,
      [limit],
    );
    return rows;
  });

  app.get<{ Params: { slug: string } }>('/projects/:slug', async (req) => {
    const project = await getProject(ctx, req.params.slug);
    const live = project.current_deployment_id
      ? ((await ctx.db.query<DeploymentRow>('SELECT * FROM deployments WHERE id = $1', [project.current_deployment_id]))
          .rows[0] ?? null)
      : null;
    return { ...publicProject(project), live };
  });

  app.get<{ Params: { slug: string }; Querystring: { limit?: string } }>(
    '/projects/:slug/deployments',
    async (req) => {
      const project = await getProject(ctx, req.params.slug);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 200);
      const { rows } = await ctx.db.query<DeploymentRow>(
        'SELECT * FROM deployments WHERE project_id = $1 ORDER BY id DESC LIMIT $2',
        [project.id, limit],
      );
      return rows;
    },
  );

  app.post<{ Params: { slug: string }; Body: { sha?: string } | null }>('/projects/:slug/deploy', async (req, reply) => {
    const project = await getProject(ctx, req.params.slug);
    if (!project.enabled) throw new HttpError(409, `project ${project.slug} was deleted or removed from projects.yml`);
    const sha = req.body?.sha;
    if (sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(sha)) throw new HttpError(400, 'invalid sha');

    // Résout la branche (ou un SHA court) en commit complet via l'API GitHub.
    let head;
    try {
      const { octokit } = await ctx.github.forRepo(project.repo);
      const result = await getBranchHead(octokit, project.repo, sha ?? project.branch);
      if (result.kind !== 'ok') throw new Error('unexpected response');
      head = result.head;
    } catch (err) {
      if (err instanceof RepoAccessError) throw err;
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 422) throw new HttpError(404, `commit not found: ${sha ?? project.branch}`);
      throw err;
    }

    const deploymentId = await tx(ctx.db, async (c) => {
      // Tête de branche : on la marque comme vue pour que webhook/poller ne la redéploient pas.
      if (!sha) {
        await c.query('UPDATE projects SET last_seen_sha = $2, updated_at = now() WHERE id = $1', [
          project.id,
          head.sha,
        ]);
      }
      return enqueueDeployment(c, {
        projectId: project.id,
        sha: head.sha,
        commitMessage: head.message,
        commitAuthor: head.author,
        trigger: 'manual',
      });
    });
    return reply.code(202).send({ deploymentId, sha: head.sha });
  });

  app.post<{ Params: { slug: string }; Body: { deploymentId?: number } | null }>(
    '/projects/:slug/rollback',
    async (req, reply) => {
      const project = await getProject(ctx, req.params.slug);
      let target: DeploymentRow | undefined;
      if (req.body?.deploymentId !== undefined) {
        target = await getDeployment(ctx, Number(req.body.deploymentId));
        if (target.project_id !== project.id) throw new HttpError(400, 'this deployment belongs to another project');
        if (!target.image_tag || !TERMINAL_STATUSES.includes(target.status) || target.status === 'failed') {
          throw new HttpError(409, `deployment ${target.id} has no valid image to reuse`);
        }
      } else {
        // Par défaut : la dernière version passée en ligne avant l'actuelle, avec un SHA différent.
        const { rows } = await ctx.db.query<DeploymentRow>(
          `SELECT d.* FROM deployments d
            WHERE d.project_id = $1 AND d.status = 'superseded' AND d.went_live_at IS NOT NULL
              AND d.image_tag IS NOT NULL
              AND d.id IS DISTINCT FROM $2
              AND d.sha IS DISTINCT FROM (SELECT sha FROM deployments WHERE id = $2)
            ORDER BY d.went_live_at DESC LIMIT 1`,
          [project.id, project.current_deployment_id],
        );
        target = rows[0];
        if (!target) throw new HttpError(409, 'no previous version to roll back to');
      }

      if (!(await imageExists(ctx.docker, target.image_tag!))) {
        throw new HttpError(
          409,
          `image ${target.image_tag} was removed, a full redeploy is needed: ` +
            `POST /api/projects/${project.slug}/deploy with { "sha": "${target.sha}" }`,
        );
      }

      const deploymentId = await tx(ctx.db, (c) =>
        enqueueDeployment(c, {
          projectId: project.id,
          sha: target.sha,
          commitMessage: target.commit_message,
          commitAuthor: target.commit_author,
          trigger: 'rollback',
          imageTag: target.image_tag,
        }),
      );
      return reply.code(202).send({ deploymentId, sha: target.sha, from: target.id });
    },
  );

  for (const action of ['pause', 'resume'] as const) {
    app.post<{ Params: { slug: string } }>(`/projects/:slug/${action}`, async (req) => {
      const project = await getProject(ctx, req.params.slug);
      await ctx.db.query('UPDATE projects SET paused = $2, updated_at = now() WHERE id = $1', [
        project.id,
        action === 'pause',
      ]);
      return { slug: project.slug, paused: action === 'pause' };
    });
  }

  /** Arrête le site : conteneur stoppé (pas supprimé), plus de relance ni d'auto-déploiement. */
  app.post<{ Params: { slug: string } }>('/projects/:slug/stop', async (req) => {
    const project = await getProject(ctx, req.params.slug);
    await ctx.db.query('UPDATE projects SET stopped = true, updated_at = now() WHERE id = $1', [project.id]);
    // Un build en cours rallumerait le site en fin de déploiement : on l'annule.
    await ctx.db.query(`UPDATE jobs SET cancel_requested = 'cancelled' WHERE project_id = $1 AND state = 'running'`, [
      project.id,
    ]);
    await ctx.db.query(
      `UPDATE deployments SET status = 'cancelled', error = 'site stopped', finished_at = now()
        WHERE project_id = $1 AND status = 'queued'`,
      [project.id],
    );
    await ctx.db.query(`UPDATE jobs SET state = 'cancelled' WHERE project_id = $1 AND state = 'pending'`, [project.id]);
    const stopped = await stopProjectContainers(ctx, project.slug);
    req.log.info({ project: project.slug, containers: stopped }, 'site stopped');
    return { slug: project.slug, stopped: true };
  });

  /** Redémarre le site arrêté, sans rebuild (recrée le conteneur depuis son image s'il a disparu). */
  app.post<{ Params: { slug: string } }>('/projects/:slug/start', async (req) => {
    const project = await getProject(ctx, req.params.slug);
    if (!project.current_deployment_id) {
      throw new HttpError(409, 'no live version to start: run a deployment');
    }
    const deployment = await getDeployment(ctx, project.current_deployment_id);
    const result = await startLiveContainer(ctx, project, deployment);
    if (result === 'image_missing') {
      throw new HttpError(409, `image ${deployment.image_tag} no longer exists: redeploy the project`);
    }
    await ctx.db.query('UPDATE projects SET stopped = false, updated_at = now() WHERE id = $1', [project.id]);
    req.log.info({ project: project.slug, result }, 'site started');
    return { slug: project.slug, stopped: false, result };
  });

  app.get<{ Params: { id: string } }>('/deployments/:id', async (req) => {
    const deployment = await getDeployment(ctx, Number(req.params.id));
    const { rows } = await ctx.db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [deployment.project_id]);
    const p = rows[0]!;
    return { ...deployment, project: { slug: p.slug, repo: p.repo, domains: p.config.domains } };
  });

  app.get<{ Params: { id: string }; Querystring: { follow?: string; after?: string } }>(
    '/deployments/:id/logs',
    async (req, reply) => {
      const deployment = await getDeployment(ctx, Number(req.params.id));
      const after = Number(req.query.after ?? 0) || 0;
      if (req.query.follow === '1' || req.query.follow === 'true') {
        return streamLogs(ctx, deployment.id, after, reply);
      }
      const { rows } = await ctx.db.query<BuildLogRow>(
        'SELECT * FROM build_logs WHERE deployment_id = $1 AND id > $2 ORDER BY id LIMIT 20000',
        [deployment.id, after],
      );
      if ((req.headers.accept ?? '').includes('application/json')) {
        return { deployment, logs: rows };
      }
      const text = rows
        .map((r) => `${new Date(r.ts).toISOString()} ${r.stream.padEnd(6)} ${r.line}`)
        .join('\n');
      return reply.type('text/plain; charset=utf-8').send(text + '\n');
    },
  );

  app.post<{ Params: { id: string } }>('/deployments/:id/cancel', async (req) => {
    const deployment = await getDeployment(ctx, Number(req.params.id));
    if (TERMINAL_STATUSES.includes(deployment.status)) {
      throw new HttpError(409, `deployment already finished (${deployment.status})`);
    }
    if (deployment.status === 'queued') {
      await tx(ctx.db, async (c) => {
        await c.query(
          `UPDATE deployments SET status = 'cancelled', error = 'cancelled', finished_at = now()
            WHERE id = $1 AND status = 'queued'`,
          [deployment.id],
        );
        await c.query(`UPDATE jobs SET state = 'cancelled' WHERE deployment_id = $1 AND state = 'pending'`, [
          deployment.id,
        ]);
      });
      return { id: deployment.id, status: 'cancelled' };
    }
    if (deployment.status === 'starting' || deployment.status === 'healthchecking') {
      throw new HttpError(409, 'switch in progress: the deployment can no longer be cancelled');
    }
    await ctx.db.query(
      `UPDATE jobs SET cancel_requested = 'cancelled' WHERE deployment_id = $1 AND state = 'running'`,
      [deployment.id],
    );
    return { id: deployment.id, status: 'cancel_requested' };
  });
}

/** GET /health (sans auth) : base et Docker joignables. */
export async function healthRoute(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get('/health', async (_req, reply) => {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return true;
      } catch {
        return false;
      }
    };
    const [db, docker] = await Promise.all([
      check(() => ctx.db.query('SELECT 1')),
      check(() => ctx.docker.ping()),
    ]);
    return reply.code(db && docker ? 200 : 503).send({ status: db && docker ? 'ok' : 'degraded', db, docker });
  });
}
