import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import type { ProjectRow } from '../db/schema.js';
import { firstLine } from '../github/client.js';
import { verifySignature } from '../github/signature.js';
import { enqueueIfNewSha } from '../queue/enqueue.js';

interface PushPayload {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { full_name?: string };
  head_commit?: { message?: string; author?: { name?: string; username?: string } } | null;
}

export type PushDecision = { deploy: true; sha: string } | { deploy: false; reason: string };

/** Filtre le contenu d'un push pour un projet donné (plan §7.2, étape 5). */
export function decidePush(payload: PushPayload, branch: string): PushDecision {
  if (payload.ref !== `refs/heads/${branch}`) return { deploy: false, reason: `ref ${payload.ref} not tracked` };
  if (payload.deleted === true) return { deploy: false, reason: 'branch deleted' };
  const sha = payload.after;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha) || /^0+$/.test(sha)) return { deploy: false, reason: 'missing SHA' };
  return { deploy: true, sha };
}

/**
 * POST /webhooks/github (plan §7.2). Aucun travail long : on valide, on enfile, on répond.
 * Enregistré dans un contexte Fastify isolé pour lire le corps brut (la signature
 * se calcule sur les octets exacts).
 */
export async function webhookRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  app.post('/webhooks/github', async (req, reply) => {
    const raw = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(raw)) return reply.code(415).send({ error: 'expected application/json' });

    const signature = req.headers['x-hub-signature-256'];
    const header = typeof signature === 'string' ? signature : undefined;
    if (!ctx.github.webhookSecrets().some((secret) => verifySignature(raw, header, secret))) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const deliveryId = String(req.headers['x-github-delivery'] ?? '');
    const event = String(req.headers['x-github-event'] ?? '');
    if (!deliveryId) return reply.code(400).send({ error: 'missing X-GitHub-Delivery' });

    let payload: PushPayload;
    try {
      payload = JSON.parse(raw.toString('utf8')) as PushPayload;
    } catch {
      return reply.code(400).send({ error: 'invalid JSON' });
    }
    const repo = payload.repository?.full_name ?? null;

    // Anti-rejeu.
    const inserted = await ctx.db.query(
      `INSERT INTO webhook_deliveries (delivery_id, event, repo, accepted, reason)
       VALUES ($1, $2, $3, false, 'processing') ON CONFLICT (delivery_id) DO NOTHING`,
      [deliveryId, event, repo],
    );
    if (inserted.rowCount === 0) return reply.code(200).send({ status: 'already processed' });

    const finish = async (code: number, accepted: boolean, reason: string, extra: object = {}) => {
      await ctx.db.query(`UPDATE webhook_deliveries SET accepted = $2, reason = $3 WHERE delivery_id = $1`, [
        deliveryId,
        accepted,
        reason,
      ]);
      req.log.info({ deliveryId, event, repo, accepted, reason }, 'webhook');
      return reply.code(code).send({ status: reason, ...extra });
    };

    if (event === 'ping') return finish(200, true, 'pong');
    if (event !== 'push') return finish(202, false, 'ignored');
    if (!repo) return finish(202, false, 'repository missing from payload');

    // Liste blanche : seuls les projets de projects.yml.
    const { rows: projects } = await ctx.db.query<ProjectRow>(
      `SELECT * FROM projects WHERE lower(repo) = lower($1) AND enabled`,
      [repo],
    );
    if (projects.length === 0) return finish(202, false, 'repository not tracked');

    let lastReason = 'ref not tracked';
    for (const project of projects) {
      const decision = decidePush(payload, project.branch);
      if (!decision.deploy) {
        lastReason = decision.reason;
        continue;
      }
      if (project.paused) return finish(202, false, `project ${project.slug} is paused`);
      if (project.stopped) return finish(202, false, `site ${project.slug} is stopped`);
      const deploymentId = await enqueueIfNewSha(
        ctx.db,
        project.id,
        {
          sha: decision.sha,
          message: firstLine(payload.head_commit?.message),
          author: payload.head_commit?.author?.name ?? payload.head_commit?.author?.username ?? null,
        },
        'webhook',
      );
      if (deploymentId === null) return finish(202, false, 'SHA already known');
      return finish(202, true, 'accepted', { deploymentId });
    }
    return finish(202, false, lastReason);
  });
}
