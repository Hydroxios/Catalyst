import { createHmac } from 'node:crypto';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context.js';
import { buildServer } from '../src/server.js';

const SECRET = 'un-secret-de-test-assez-long';

/** Base factice : enregistre les requêtes, répond selon des règles simples. */
function fakeCtx(opts: { duplicate?: boolean; projects?: unknown[] } = {}) {
  const queries: string[] = [];
  const db = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('INSERT INTO webhook_deliveries')) return { rowCount: opts.duplicate ? 0 : 1, rows: [] };
      if (sql.includes('FROM projects')) return { rowCount: opts.projects?.length ?? 0, rows: opts.projects ?? [] };
      return { rowCount: 1, rows: [] };
    },
  };
  const ctx = {
    env: { GITHUB_WEBHOOK_SECRET: SECRET, ADMIN_TOKEN: 'x'.repeat(20), PUBLIC_URL: 'https://catalyst.test' },
    db,
    github: { webhookSecrets: () => [SECRET], isAdmin: () => false, mode: 'none' },
    log: pino({ level: 'silent' }),
  } as unknown as Ctx;
  return { ctx, queries };
}

function send(app: Awaited<ReturnType<typeof buildServer>>, event: string, payload: unknown, secret = SECRET) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': 'delivery-1',
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    },
    payload: body,
  });
}

describe('POST /webhooks/github', () => {
  it('401 si la signature est invalide, sans toucher à la base', async () => {
    const { ctx, queries } = fakeCtx();
    const app = await buildServer(ctx);
    const res = await send(app, 'push', { a: 1 }, 'mauvais-secret-xxxxxxxx');
    expect(res.statusCode).toBe(401);
    expect(queries).toHaveLength(0);
  });

  it('répond pong à un ping', async () => {
    const { ctx } = fakeCtx();
    const app = await buildServer(ctx);
    const res = await send(app, 'ping', { zen: 'ok' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'pong' });
  });

  it('200 « déjà traité » pour une livraison rejouée', async () => {
    const { ctx } = fakeCtx({ duplicate: true });
    const app = await buildServer(ctx);
    const res = await send(app, 'push', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'already processed' });
  });

  it('ignore les événements autres que push', async () => {
    const { ctx } = fakeCtx();
    const app = await buildServer(ctx);
    const res = await send(app, 'issues', {});
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'ignored' });
  });

  it("ignore un dépôt absent de la liste blanche", async () => {
    const { ctx } = fakeCtx({ projects: [] });
    const app = await buildServer(ctx);
    const res = await send(app, 'push', { repository: { full_name: 'inconnu/repo' }, ref: 'refs/heads/main' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'repository not tracked' });
  });

  it('accepte un webhook signé avec le secret de la GitHub App', async () => {
    const { ctx } = fakeCtx();
    (ctx.github as unknown as { webhookSecrets: () => string[] }).webhookSecrets = () => ['secret-de-l-app-xxxxxxxx', SECRET];
    const app = await buildServer(ctx);
    const res = await send(app, 'ping', {}, 'secret-de-l-app-xxxxxxxx');
    expect(res.statusCode).toBe(200);
  });

  it("l'API refuse une session inconnue", async () => {
    const { ctx } = fakeCtx();
    const app = await buildServer(ctx);
    const res = await app.inject({ method: 'GET', url: '/api/projects', cookies: { catalyst_session: 'inconnu' } });
    expect(res.statusCode).toBe(401);
  });

  it("l'API exige le token admin", async () => {
    const { ctx } = fakeCtx();
    const app = await buildServer(ctx);
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(401);
  });
});
