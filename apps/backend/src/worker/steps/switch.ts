import type { Ctx } from '../../context.js';
import { removeContainer } from '../../docker/client.js';
import { sleep } from '../../utils/time.js';
import type { DeploymentLogger } from '../logger.js';

const DRAIN_MS = 5_000;
const STOP_GRACE_SECONDS = 30;

/**
 * Fin de la bascule blue/green (plan §12) : le nouveau conteneur est déjà routé
 * et sain, Traefik répartit entre ancien et nouveau ; on laisse les requêtes en
 * cours se terminer puis on arrête les anciens conteneurs. Les images restent
 * (rollback).
 */
export async function retireOldContainers(
  ctx: Ctx,
  slug: string,
  keepName: string,
  logger: DeploymentLogger,
): Promise<void> {
  const containers = await ctx.docker.listContainers({
    all: true,
    filters: { label: [`catalyst.project=${slug}`] },
  });
  const old = containers
    .map((c) => (c.Names[0] ?? '').replace(/^\//, ''))
    .filter((name) => name && name !== keepName);
  if (old.length === 0) return;

  logger.system(`traffic split between old and new version, draining for ${DRAIN_MS / 1000}s`);
  await sleep(DRAIN_MS);
  for (const name of old) {
    logger.system(`■ stopping old container ${name}`);
    try {
      await removeContainer(ctx.docker, name, STOP_GRACE_SECONDS);
    } catch (err) {
      logger.system(`⚠ could not remove ${name}: ${(err as Error).message}`);
    }
  }
}
