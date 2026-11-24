import type { Ctx } from './context.js';
import type { DeploymentRow, ProjectRow } from './db/schema.js';
import { imageExists, inspectContainer } from './docker/client.js';
import { notifyText } from './notify/discord.js';
import { readProjectEnv, startContainer } from './worker/steps/run.js';

/** Crée le réseau partagé avec Traefik s'il n'existe pas (normalement créé par docker compose). */
export async function ensureNetwork(ctx: Ctx): Promise<void> {
  const name = ctx.env.DOCKER_NETWORK;
  const networks = await ctx.docker.listNetworks({ filters: { name: [name] } });
  if (networks.some((n) => n.Name === name)) return;
  await ctx.docker.createNetwork({ Name: name, Driver: 'bridge' });
  ctx.log.warn({ network: name }, 'Docker network created (Traefik must be attached to it)');
}

export type StartResult = 'running' | 'started' | 'recreated' | 'image_missing';

/**
 * (Re)met en route le conteneur du déploiement en ligne : rien si il tourne déjà,
 * `docker start` s'il est arrêté, recréation depuis l'image s'il a disparu.
 */
export async function startLiveContainer(ctx: Ctx, project: ProjectRow, d: DeploymentRow): Promise<StartResult> {
  const name = d.container_name;
  if (!name || !d.image_tag) return 'image_missing';
  const info = await inspectContainer(ctx.docker, name);
  if (info?.State.Running) return 'running';
  if (info) {
    await ctx.docker.getContainer(name).start();
    return 'started';
  }
  if (!(await imageExists(ctx.docker, d.image_tag))) return 'image_missing';
  await startContainer(ctx, project.config, {
    sha: d.sha,
    deploymentId: d.id,
    image: d.image_tag,
    name,
    routed: true,
    env: readProjectEnv(ctx, project.slug),
  });
  return 'recreated';
}

/** Arrête (sans les supprimer) les conteneurs d'un projet : le site ne répond plus. */
export async function stopProjectContainers(ctx: Ctx, slug: string): Promise<number> {
  const containers = await ctx.docker.listContainers({ filters: { label: [`catalyst.project=${slug}`] } });
  for (const c of containers) {
    try {
      await ctx.docker.getContainer(c.Id).stop({ t: 10 });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
  }
  return containers.length;
}

/**
 * Au démarrage (plan §17.2) : vérifie que le conteneur du déploiement en ligne
 * de chaque projet tourne ; sinon le relance depuis son image et signale l'incident.
 * Les sites arrêtés volontairement ne sont pas relancés.
 */
export async function reconcile(ctx: Ctx): Promise<void> {
  const { rows } = await ctx.db.query<ProjectRow & { deployment: DeploymentRow }>(
    `SELECT p.*, to_jsonb(d) AS deployment
       FROM projects p JOIN deployments d ON d.id = p.current_deployment_id
      WHERE p.enabled AND NOT p.stopped`,
  );
  for (const project of rows) {
    const d = project.deployment;
    try {
      const result = await startLiveContainer(ctx, project, d);
      if (result === 'running') continue;
      if (result === 'image_missing') {
        const msg = `🚨 ${project.slug}: the live container ${d.container_name} is gone and so is its image ${d.image_tag} — redeploy needed`;
        ctx.log.error({ project: project.slug, container: d.container_name }, msg);
        await notifyText(ctx, msg);
        continue;
      }
      const action = result === 'started' ? 'restarted' : 'recreated from its image';
      const msg = `⚠️ ${project.slug}: the live container ${d.container_name} was not running, ${action}`;
      ctx.log.warn({ project: project.slug, container: d.container_name }, msg);
      await notifyText(ctx, msg);
    } catch (err) {
      ctx.log.error({ err, project: project.slug }, 'reconciliation failed');
    }
  }
}
