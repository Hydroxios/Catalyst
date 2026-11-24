import pg from 'pg';
import type { Ctx } from '../context.js';
import { claimJob, recoverOrphans } from '../queue/claim.js';
import { JOBS_CHANNEL } from '../queue/enqueue.js';
import { sleep } from '../utils/time.js';
import { runDeployment } from './pipeline.js';

const POLL_MS = 2_000;
const ORPHAN_CHECK_MS = 60_000;

/**
 * Boucle principale (plan §9.3) : prend les jobs un par un, jusqu'à
 * WORKER_CONCURRENCY en parallèle (max 1 par projet, garanti par la requête de prise).
 * Réveil immédiat via LISTEN/NOTIFY, sinon toutes les 2 s.
 */
export class Worker {
  private readonly active = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();
  private ticking = false;
  private retick = false;
  private listener: pg.Client | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly ctx: Ctx) {}

  async start(): Promise<void> {
    this.timers.push(setInterval(() => this.tick(), POLL_MS));
    this.timers.push(
      setInterval(() => {
        recoverOrphans(this.ctx.db)
          .then((r) => {
            if (r.resumed > 0) this.ctx.log.warn({ count: r.resumed }, 'orphan deployments re-queued');
            if (r.failed > 0) this.ctx.log.warn({ count: r.failed }, 'orphan deployments marked as failed');
            if (r.resumed > 0) this.tick();
          })
          .catch((err) => this.ctx.log.error({ err }, 'orphan job recovery failed'));
      }, ORPHAN_CHECK_MS),
    );
    await this.listen();
    this.tick();
    this.ctx.log.info({ concurrency: this.ctx.env.WORKER_CONCURRENCY }, 'worker started');
  }

  private async listen(): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    const client = new pg.Client({ connectionString: this.ctx.env.DATABASE_URL });
    client.on('notification', () => this.tick());
    client.on('error', (err) => {
      this.ctx.log.warn({ err }, 'LISTEN connection lost, reconnecting in 5s (polling continues)');
      this.listener = null;
      client.end().catch(() => {});
      void sleep(5_000, this.shutdown.signal).then(() => this.listen().catch(() => {}));
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${JOBS_CHANNEL}`);
      this.listener = client;
    } catch (err) {
      this.ctx.log.warn({ err }, 'LISTEN unavailable, polling only');
      client.end().catch(() => {});
    }
  }

  tick(): void {
    if (this.shutdown.signal.aborted) return;
    if (this.ticking) {
      this.retick = true;
      return;
    }
    this.ticking = true;
    void this.fill()
      .catch((err) => this.ctx.log.error({ err }, 'claiming a job failed'))
      .finally(() => {
        this.ticking = false;
        if (this.retick) {
          this.retick = false;
          this.tick();
        }
      });
  }

  private async fill(): Promise<void> {
    while (!this.shutdown.signal.aborted && this.active.size < this.ctx.env.WORKER_CONCURRENCY) {
      const job = await claimJob(this.ctx.db);
      if (!job) return;
      this.ctx.log.info({ jobId: job.id, deploymentId: job.deployment_id }, 'job claimed');
      const run: Promise<void> = runDeployment(this.ctx, job, this.shutdown.signal)
        .catch((err) => this.ctx.log.error({ err, jobId: job.id }, 'job failed unexpectedly'))
        .finally(() => {
          this.active.delete(run);
          this.tick();
        });
      this.active.add(run);
    }
  }

  /** Arrêt propre : annule les builds en cours (ceux en phase de bascule vont au bout). */
  async stop(timeoutMs = 60_000): Promise<void> {
    this.shutdown.abort();
    for (const t of this.timers) clearInterval(t);
    await this.listener?.end().catch(() => {});
    await Promise.race([Promise.allSettled([...this.active]), sleep(timeoutMs)]);
  }
}
