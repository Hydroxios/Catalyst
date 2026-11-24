import { mkdirSync } from 'node:fs';
import { pino } from 'pino';
import { loadEnv } from './config/env.js';
import { loadProjects, syncProjects } from './config/projects.js';
import type { Ctx } from './context.js';
import { createPool, migrate } from './db/client.js';
import { createDocker } from './docker/client.js';
import { GitHubService } from './github/service.js';
import { SettingsStore } from './settings.js';
import { scheduleMaintenance } from './maintenance/cleanup.js';
import { Poller } from './poller/poller.js';
import { ORPHAN_AFTER_SECONDS, recoverOrphans } from './queue/claim.js';
import { ensureNetwork, reconcile } from './reconcile.js';
import { buildServer } from './server.js';
import { Worker } from './worker/worker.js';

async function main(): Promise<void> {
  // Config invalide → refus de démarrer avec l'erreur exacte (plan §5.3).
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL, redact: ['req.headers.authorization'] });
  const projects = loadProjects(env.PROJECTS_FILE, env.BASE_DOMAIN);

  const db = createPool(env.DATABASE_URL);
  // Connexion inactive coupée (Postgres redémarré) : pg la retire du pool ; sans écouteur, le process plante.
  db.on('error', (err) => log.warn({ err }, 'idle database connection lost'));
  await migrate(db, log);
  await syncProjects(db, projects);
  log.info({ projects: projects.map((p) => p.slug), role: env.ROLE }, 'configuration loaded');

  mkdirSync(env.WORKDIR, { recursive: true });
  mkdirSync(env.SECRETS_DIR, { recursive: true });

  const github = new GitHubService(env, log);
  log.info({ mode: github.mode, app: github.app?.slug }, 'GitHub access');
  const settings = new SettingsStore(env.DATA_DIR, log);
  const ctx: Ctx = { env, db, log, docker: createDocker(), github, settings };
  const stops: (() => Promise<void> | void)[] = [];

  if (env.ROLE !== 'api') {
    await ensureNetwork(ctx);
    // Process unique : tout job `running` en base a été interrompu par l'arrêt précédent.
    const orphans = await recoverOrphans(db, env.ROLE === 'all' ? 0 : ORPHAN_AFTER_SECONDS);
    if (orphans.resumed > 0) log.warn({ count: orphans.resumed }, 'deployments interrupted by the restart: resuming');
    if (orphans.failed > 0) log.warn({ count: orphans.failed }, 'interrupted deployments marked as failed');
    await reconcile(ctx);
    const worker = new Worker(ctx);
    await worker.start();
    stops.push(() => worker.stop());
    stops.push(scheduleMaintenance(ctx));
  }

  if (env.ROLE !== 'worker') {
    const app = await buildServer(ctx);
    await app.listen({ port: env.PORT, host: env.HOST });
    stops.unshift(() => app.close());
    const poller = new Poller(ctx);
    poller.start();
    stops.unshift(() => poller.stop());
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    for (const stop of stops) {
      try {
        await stop();
      } catch (err) {
        log.error({ err }, 'error during shutdown');
      }
    }
    await db.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled promise rejection'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
