import { statfs } from 'node:fs/promises';
import type { Ctx } from '../context.js';
import { removeContainer } from '../docker/client.js';
import { selectImagesToDelete, type ImageInfo } from '../docker/spec.js';
import { notifyText } from '../notify/discord.js';
import { runCommand } from '../utils/command.js';

const RETENTION_DAYS = 30;
const DISK_ALERT_RATIO = 0.1;

/** Tags d'images à ne jamais supprimer : image en ligne + images des jobs en cours. */
async function protectedTags(ctx: Ctx, projectId?: number): Promise<Set<string>> {
  const { rows } = await ctx.db.query<{ image_tag: string }>(
    `SELECT d.image_tag FROM projects p JOIN deployments d ON d.id = p.current_deployment_id
      WHERE d.image_tag IS NOT NULL AND ($1::int IS NULL OR p.id = $1)
     UNION
     SELECT d.image_tag FROM jobs j JOIN deployments d ON d.id = j.deployment_id
      WHERE j.state IN ('pending', 'running') AND d.image_tag IS NOT NULL AND ($1::int IS NULL OR j.project_id = $1)`,
    [projectId ?? null],
  );
  return new Set(rows.map((r) => r.image_tag));
}

/** Garde les KEEP_IMAGES images les plus récentes d'un projet + celle en ligne (plan §18.1). */
export async function pruneProjectImages(ctx: Ctx, project: { id: number; slug: string }): Promise<number> {
  const images = await ctx.docker.listImages({ filters: { label: [`catalyst.project=${project.slug}`] } });
  const infos: ImageInfo[] = images.map((img) => ({ id: img.Id, tags: img.RepoTags ?? [], created: img.Created }));
  const toDelete = selectImagesToDelete(infos, ctx.env.KEEP_IMAGES, await protectedTags(ctx, project.id));
  let removed = 0;
  for (const img of toDelete) {
    try {
      await ctx.docker.getImage(img.id).remove({ force: false });
      removed++;
    } catch (err) {
      ctx.log.warn({ err, image: img.tags.join(',') || img.id }, 'could not remove image');
    }
  }
  if (removed > 0) ctx.log.info({ project: project.slug, removed }, 'old images removed');
  return removed;
}

/** Conteneurs `catalyst.project` qui ne correspondent à aucun déploiement en ligne (plan §18.2). */
async function removeOrphanContainers(ctx: Ctx): Promise<void> {
  const { rows: live } = await ctx.db.query<{ container_name: string }>(
    `SELECT d.container_name FROM projects p JOIN deployments d ON d.id = p.current_deployment_id
      WHERE d.container_name IS NOT NULL`,
  );
  const liveNames = new Set(live.map((r) => r.container_name));
  // Un déploiement en cours a légitimement un conteneur candidat non encore en ligne.
  const { rows: busy } = await ctx.db.query<{ slug: string }>(
    `SELECT DISTINCT p.slug FROM jobs j JOIN projects p ON p.id = j.project_id WHERE j.state = 'running'`,
  );
  const busySlugs = new Set(busy.map((r) => r.slug));

  const containers = await ctx.docker.listContainers({ all: true, filters: { label: ['catalyst.project'] } });
  for (const c of containers) {
    const name = (c.Names[0] ?? '').replace(/^\//, '');
    const slug = c.Labels['catalyst.project'] ?? '';
    if (!name || liveNames.has(name) || busySlugs.has(slug)) continue;
    ctx.log.info({ container: name }, 'removing an orphan container');
    await removeContainer(ctx.docker, name, 10).catch((err) =>
      ctx.log.warn({ err, container: name }, 'could not remove orphan container'),
    );
  }
}

/** Tâche quotidienne (plan §18). Chaque sous-tâche est indépendante : une erreur n'empêche pas les autres. */
export async function runMaintenance(ctx: Ctx): Promise<void> {
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      ctx.log.error({ err }, `maintenance: ${label} failed`);
    }
  };

  await step('images', async () => {
    const { rows } = await ctx.db.query<{ id: number; slug: string }>('SELECT id, slug FROM projects');
    for (const p of rows) await pruneProjectImages(ctx, p);
  });
  await step('orphan containers', () => removeOrphanContainers(ctx));
  await step('build cache', () =>
    runCommand('docker', ['builder', 'prune', '--filter', 'until=168h', '-f'], { timeoutMs: 10 * 60_000 }),
  );
  await step('build logs', () =>
    ctx.db.query(
      `DELETE FROM build_logs WHERE deployment_id IN (
         SELECT id FROM deployments WHERE queued_at < now() - make_interval(days => $1))`,
      [RETENTION_DAYS],
    ),
  );
  await step('sessions', () => ctx.db.query('DELETE FROM sessions WHERE expires_at < now()'));
  await step('webhooks', () =>
    ctx.db.query(`DELETE FROM webhook_deliveries WHERE received_at < now() - make_interval(days => $1)`, [
      RETENTION_DAYS,
    ]),
  );
  await step('disk', async () => {
    const s = await statfs(ctx.env.WORKDIR);
    const free = s.bavail / s.blocks;
    if (free < DISK_ALERT_RATIO) {
      const pct = (free * 100).toFixed(1);
      ctx.log.warn({ free: pct }, 'low disk space');
      await notifyText(ctx, `⚠️ Low disk space on the deployment platform: ${pct}% free`);
    }
  });
}

export function scheduleMaintenance(ctx: Ctx): () => void {
  const run = () => void runMaintenance(ctx).catch((err) => ctx.log.error({ err }, 'maintenance failed'));
  const first = setTimeout(run, 60_000);
  const daily = setInterval(run, 24 * 3600_000);
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
