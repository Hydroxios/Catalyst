import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../../context.js';
import type { ProjectConfig } from '../../config/projects.js';
import { removeContainer } from '../../docker/client.js';
import { buildContainerSpec, parseEnvFile } from '../../docker/spec.js';

/** Variables d'env runtime du projet : `${SECRETS_DIR}/<slug>.env` (jamais dans projects.yml). */
export function readProjectEnv(ctx: Ctx, slug: string): string[] {
  const file = join(ctx.env.SECRETS_DIR, `${slug}.env`);
  if (!existsSync(file)) return [];
  return parseEnvFile(readFileSync(file, 'utf8'));
}

export function healthTimeout(ctx: Ctx, project: ProjectConfig): number {
  return project.healthcheck.timeout_seconds ?? ctx.env.HEALTHCHECK_TIMEOUT_SECONDS;
}

export interface StartOptions {
  sha: string;
  deploymentId: number;
  image: string;
  name: string;
  routed: boolean;
  env: string[];
}

/** Crée et démarre le conteneur d'un déploiement (plan §10.3 et §12). */
export async function startContainer(ctx: Ctx, project: ProjectConfig, opts: StartOptions): Promise<void> {
  // Reste d'une tentative précédente avec le même nom.
  await removeContainer(ctx.docker, opts.name, 0);
  const spec = buildContainerSpec({
    project,
    sha: opts.sha,
    deploymentId: opts.deploymentId,
    image: opts.image,
    name: opts.name,
    routed: opts.routed,
    dockerHealthcheck: project.healthcheck.mode === 'docker',
    healthTimeoutSeconds: healthTimeout(ctx, project),
    env: opts.env,
    traefik: {
      network: ctx.env.DOCKER_NETWORK,
      entrypoint: ctx.env.TRAEFIK_ENTRYPOINT,
      certResolver: ctx.env.TRAEFIK_CERT_RESOLVER,
    },
  });
  const container = await ctx.docker.createContainer(spec);
  await container.start();
}
