import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { apiRoutes, healthRoute } from './api/routes.js';
import { authRoutes } from './auth/routes.js';
import type { Ctx } from './context.js';
import { faviconRoutes } from './favicon.js';
import { webhookRoutes } from './receiver/webhook.js';

// L'interface interroge l'API toutes les quelques secondes : on ne journalise que les problèmes.
const QUIET = 'warn' as const;

export async function buildServer(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    trustProxy: true,
  });
  // Chaque groupe de routes dans son propre contexte : le receiver lit le corps brut,
  // l'API garde le parseur JSON standard.
  await app.register(fastifyCookie);
  await app.register(async (i) => healthRoute(i, ctx), { logLevel: QUIET });
  await app.register(async (i) => authRoutes(i, ctx), { logLevel: QUIET });
  await app.register(async (i) => webhookRoutes(i, ctx));
  await app.register(async (i) => faviconRoutes(i, ctx), { logLevel: QUIET });
  await app.register(async (i) => apiRoutes(i, ctx), { prefix: '/api', logLevel: QUIET });

  // Interface web (front compilé). Routage côté client par hash (#/...) : pas de fallback SPA nécessaire.
  const webDir = resolve(ctx.env.WEB_DIR ?? fileURLToPath(new URL('../web/', import.meta.url)));
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, index: 'index.html', logLevel: QUIET });
  } else {
    ctx.log.info({ webDir }, 'web UI not found (missing folder), serving the API only');
  }
  return app;
}
