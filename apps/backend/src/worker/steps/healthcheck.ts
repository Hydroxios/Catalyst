import type { Ctx } from '../../context.js';
import type { ProjectConfig } from '../../config/projects.js';
import { containerLogsTail, inspectContainer } from '../../docker/client.js';
import { sleep } from '../../utils/time.js';
import { StepError } from '../errors.js';
import type { DeploymentLogger } from '../logger.js';

const REQUIRED_SUCCESSES = 3;

/** « fetch failed » → cause lisible (connexion refusée = l'app n'écoute pas sur ce port). */
export function describeFetchError(err: unknown, port: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  const code = e.cause?.code;
  if (code === 'ECONNREFUSED') {
    return `connection refused on port ${port}: the app is not listening on this port (it must listen on 0.0.0.0:$PORT, here ${port})`;
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return `connection reset by the app on port ${port}`;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return `no response within 2s on port ${port}`;
  return e.message ?? String(err);
}
const INTERVAL_MS = 2_000;

async function dumpContainerLogs(ctx: Ctx, name: string, logger: DeploymentLogger): Promise<void> {
  const lines = await containerLogsTail(ctx.docker, name, 100);
  logger.system(`— last ${lines.length} log lines of container ${name} —`);
  for (const { stream, line } of lines) logger.push(stream, line);
}

/**
 * Attend que le conteneur réponde (plan §10.4) : HTTP 200–399 trois fois de suite
 * sur son IP du réseau partagé, et, en mode `docker`, statut Docker `healthy`
 * (c'est ce qui autorise Traefik à lui envoyer du trafic — plan §12).
 */
export async function waitHealthy(
  ctx: Ctx,
  project: ProjectConfig,
  name: string,
  logger: DeploymentLogger,
  opts: { useDockerHealth: boolean; timeoutSeconds: number },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  const { port, healthcheck } = project;
  let successes = 0;
  let lastIssue = 'no response';
  let lastDockerHealth: string | undefined;

  logger.system(`▶ healthcheck GET ${healthcheck.path} (port ${port}, ${opts.timeoutSeconds}s max)`);
  for (;;) {
    const info = await inspectContainer(ctx.docker, name);
    if (!info) throw new StepError(`container ${name} disappeared`);
    if (!info.State.Running) {
      await dumpContainerLogs(ctx, name, logger);
      throw new StepError(`the container stopped during startup (exit code ${info.State.ExitCode})`);
    }
    // Plante et redémarre en boucle (politique unless-stopped) : inutile d'attendre la fin du délai.
    if (info.State.Restarting || info.RestartCount >= 2) {
      await dumpContainerLogs(ctx, name, logger);
      throw new StepError(
        `the container crashes on startup and keeps restarting (${info.RestartCount} restart(s)): see its logs above`,
      );
    }

    const dockerHealth = info.State.Health?.Status;
    if (opts.useDockerHealth && dockerHealth !== lastDockerHealth) {
      logger.system(`Docker status: ${dockerHealth ?? 'unknown'}`);
      lastDockerHealth = dockerHealth;
    }

    const ip = info.NetworkSettings.Networks[ctx.env.DOCKER_NETWORK]?.IPAddress;
    if (!ip) {
      successes = 0;
      lastIssue = `no IP on network ${ctx.env.DOCKER_NETWORK}`;
    } else {
      try {
        const res = await fetch(`http://${ip}:${port}${healthcheck.path}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(2_000),
        });
        await res.body?.cancel();
        if (res.status >= 200 && res.status < 400) {
          successes++;
        } else {
          successes = 0;
          lastIssue = `HTTP ${res.status}`;
        }
      } catch (err) {
        successes = 0;
        lastIssue = describeFetchError(err, port);
      }
    }

    const httpOk = successes >= REQUIRED_SUCCESSES;
    const dockerOk = !opts.useDockerHealth || dockerHealth === 'healthy';
    if (httpOk && dockerOk) {
      logger.system('✔ healthcheck OK');
      return;
    }

    if (Date.now() > deadline) {
      await dumpContainerLogs(ctx, name, logger);
      const reason =
        httpOk && !dockerOk
          ? `the app responds but the Docker healthcheck stays "${dockerHealth ?? 'unknown'}" ` +
            `(the image has no wget, curl, node, or python? switch the rollout mode to "simple")`
          : lastIssue;
      throw new StepError(`healthcheck failed after ${opts.timeoutSeconds}s: ${reason}`);
    }
    await sleep(INTERVAL_MS);
  }
}
