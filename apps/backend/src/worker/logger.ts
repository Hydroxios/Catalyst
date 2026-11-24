import type { Logger } from 'pino';
import type { Db } from '../db/client.js';

type Stream = 'system' | 'stdout' | 'stderr';

const MAX_LINE = 4000;
const FLUSH_INTERVAL_MS = 500;
const MAX_BUFFER = 500;

/** Masque les secrets connus et toute URL `x-access-token:...@`. */
export function maskSecrets(line: string, secrets: readonly string[]): string {
  let out = line.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
  for (const s of secrets) if (s.length >= 6) out = out.split(s).join('***');
  return out;
}

/**
 * Écrit les logs d'un déploiement dans `build_logs`, par lots toutes les 500 ms (plan §14.1).
 * Les secrets fournis ne sont jamais écrits en clair.
 */
export class DeploymentLogger {
  private buffer: { ts: Date; stream: Stream; line: string }[] = [];
  private timer: NodeJS.Timeout;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly deploymentId: number,
    private readonly log: Logger,
    private readonly secrets: string[] = [],
  ) {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  addSecret(secret: string): void {
    this.secrets.push(secret);
  }

  system(message: string): void {
    this.push('system', message);
    this.log.info({ deploymentId: this.deploymentId }, maskSecrets(message, this.secrets));
  }

  push(stream: Stream, line: string): void {
    // Postgres refuse \0 dans un TEXT ; les codes ANSI n'apportent rien en base.
    const clean = maskSecrets(line, this.secrets)
      .replace(/\0/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .slice(0, MAX_LINE);
    this.buffer.push({ ts: new Date(), stream, line: clean });
    if (this.buffer.length >= MAX_BUFFER) void this.flush();
  }

  flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      if (this.buffer.length === 0) return;
      const batch = this.buffer;
      this.buffer = [];
      try {
        await this.db.query(
          `INSERT INTO build_logs (deployment_id, ts, stream, line)
           SELECT $1, * FROM unnest($2::timestamptz[], $3::text[], $4::text[])`,
          [this.deploymentId, batch.map((b) => b.ts), batch.map((b) => b.stream), batch.map((b) => b.line)],
        );
      } catch (err) {
        this.log.error({ err, deploymentId: this.deploymentId }, 'could not write build logs');
      }
    });
    return this.flushing;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}
