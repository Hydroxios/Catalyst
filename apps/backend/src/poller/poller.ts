import type { Ctx } from '../context.js';
import type { ProjectRow } from '../db/schema.js';
import { getBranchHead, RateLimitError } from '../github/client.js';
import { enqueueIfNewSha } from '../queue/enqueue.js';
import { sleep } from '../utils/time.js';

const MAX_JITTER_MS = 5_000;

/**
 * Polling de secours (plan §8) : rattrape les webhooks perdus.
 * Requêtes conditionnelles (ETag) : un 304 ne compte pas dans le quota GitHub.
 */
export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pausedUntil = 0;
  private readonly stopped = new AbortController();

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    const intervalMs = this.ctx.env.POLL_INTERVAL_SECONDS * 1000;
    setTimeout(() => void this.pollAll(), 5_000).unref();
    this.timer = setInterval(() => void this.pollAll(), intervalMs);
    this.ctx.log.info({ intervalSeconds: this.ctx.env.POLL_INTERVAL_SECONDS }, 'poller started');
  }

  stop(): void {
    this.stopped.abort();
    if (this.timer) clearInterval(this.timer);
  }

  async pollAll(): Promise<void> {
    if (this.running || this.stopped.signal.aborted) return;
    if (Date.now() < this.pausedUntil) return;
    this.running = true;
    try {
      const { rows } = await this.ctx.db.query<ProjectRow>(
        `SELECT * FROM projects WHERE enabled AND NOT paused AND NOT stopped ORDER BY id`,
      );
      for (const project of rows) {
        // Étaler les appels.
        await sleep(Math.random() * MAX_JITTER_MS, this.stopped.signal);
        if (this.stopped.signal.aborted) return;
        try {
          await this.pollOne(project);
        } catch (err) {
          if (err instanceof RateLimitError) {
            this.pausedUntil = err.resetAt.getTime();
            this.ctx.log.warn({ resetAt: err.resetAt }, 'GitHub quota exhausted, poller paused');
            return;
          }
          this.ctx.log.warn({ err, project: project.slug }, 'polling failed, retrying on the next round');
        }
      }
    } catch (err) {
      this.ctx.log.error({ err }, 'polling round failed');
    } finally {
      this.running = false;
    }
  }

  async pollOne(project: ProjectRow): Promise<void> {
    const { octokit } = await this.ctx.github.forRepo(project.repo);
    const result = await getBranchHead(octokit, project.repo, project.branch, project.github_etag);
    if (result.kind === 'not_modified') return;

    await this.ctx.db.query(`UPDATE projects SET github_etag = $2 WHERE id = $1`, [project.id, result.etag]);

    // Premier démarrage : on mémorise le SHA ; on déploie seulement si deploy_on_first_seen.
    if (project.last_seen_sha === null && !project.config.deploy_on_first_seen) {
      await this.ctx.db.query(
        `UPDATE projects SET last_seen_sha = $2, updated_at = now() WHERE id = $1 AND last_seen_sha IS NULL`,
        [project.id, result.head.sha],
      );
      this.ctx.log.info({ project: project.slug, sha: result.head.sha }, 'first SHA recorded without deploying');
      return;
    }

    const deploymentId = await enqueueIfNewSha(this.ctx.db, project.id, result.head, 'poll');
    if (deploymentId !== null) {
      this.ctx.log.info({ project: project.slug, sha: result.head.sha, deploymentId }, 'new commit detected by polling');
    }
  }
}
