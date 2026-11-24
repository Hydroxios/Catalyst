import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { authenticate, cookieOptions, createSession, destroySession } from './session.js';

const OAUTH_STATE_COOKIE = 'catalyst_oauth_state';
const MANIFEST_STATE_TTL_MS = 60 * 60_000;

/** États du flux « manifest » en cours (émis uniquement à un admin connecté). */
const manifestStates = new Map<string, number>();

/** Adresse qui ne sort pas de la machine (test en local). */
export function isLocalHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
}

/**
 * URL des webhooks joignable par GitHub, ou null si aucune (Catalyst en local sans relais :
 * GitHub refuse les webhooks vers localhost, le polling prend le relais).
 */
export function publicWebhookUrl(ctx: Ctx): string | null {
  if (ctx.env.GITHUB_WEBHOOK_URL) return ctx.env.GITHUB_WEBHOOK_URL;
  if (isLocalHost(new URL(ctx.env.PUBLIC_URL).hostname)) return null;
  return `${base(ctx)}/webhooks/github`;
}

function base(ctx: Ctx): string {
  return ctx.env.PUBLIC_URL.replace(/\/$/, '');
}

/** Retour vers l'interface avec un message (routage par hash côté front). */
function toUi(ctx: Ctx, path: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  return `${base(ctx)}/#${path}${query ? `?${query}` : ''}`;
}

/** Manifest de la GitHub App (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). */
export function appManifest(ctx: Ctx) {
  // Nom unique sur GitHub, sans caractères exotiques (modifiable sur la page de création).
  const host = new URL(ctx.env.PUBLIC_URL).hostname.replace(/[^A-Za-z0-9.-]/g, '');
  const hookUrl = publicWebhookUrl(ctx);
  return {
    name: `Catalyst ${host}`.slice(0, 34),
    url: base(ctx),
    ...(hookUrl ? { hook_attributes: { url: hookUrl, active: true } } : {}),
    redirect_url: `${base(ctx)}/auth/github/app-created`,
    callback_urls: [`${base(ctx)}/auth/github/callback`],
    setup_url: `${base(ctx)}/auth/github/installed`,
    setup_on_update: true,
    request_oauth_on_install: false,
    public: false,
    default_permissions: { contents: 'read', metadata: 'read', statuses: 'write' },
    default_events: hookUrl ? ['push'] : [],
  };
}

export function issueManifestState(): string {
  const now = Date.now();
  for (const [s, exp] of manifestStates) if (exp < now) manifestStates.delete(s);
  const state = randomBytes(16).toString('hex');
  manifestStates.set(state, now + MANIFEST_STATE_TTL_MS);
  return state;
}

/** Routes publiques /auth/* : connexion GitHub et création de la GitHub App. */
export async function authRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get('/auth/config', async () => ({
    github: ctx.github.mode === 'app',
    appName: ctx.github.app?.name ?? null,
  }));

  app.get('/auth/me', async (req, reply) => {
    const user = await authenticate(ctx, req);
    if (!user) return reply.code(401).send({ error: 'not signed in' });
    return user;
  });

  app.post('/auth/logout', async (req, reply) => {
    await destroySession(ctx, req, reply);
    return { ok: true };
  });

  // --- Connexion avec GitHub (OAuth de la GitHub App) ---

  app.get('/auth/github/login', async (_req, reply) => {
    if (ctx.github.mode !== 'app') return reply.redirect(toUi(ctx, '/', { auth_error: 'GitHub App is not configured' }));
    const state = randomBytes(16).toString('hex');
    reply.setCookie(OAUTH_STATE_COOKIE, state, { ...cookieOptions(ctx, 600), path: '/auth' });
    return reply.redirect(ctx.github.authorizeUrl(state, `${base(ctx)}/auth/github/callback`));
  });

  app.get<{ Querystring: { code?: string; state?: string; error_description?: string } }>(
    '/auth/github/callback',
    async (req, reply) => {
      const expected = req.cookies[OAUTH_STATE_COOKIE];
      reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth' });
      if (req.query.error_description) return reply.redirect(toUi(ctx, '/', { auth_error: req.query.error_description }));
      if (!req.query.code || !expected || req.query.state !== expected) {
        return reply.redirect(toUi(ctx, '/', { auth_error: 'sign-in session expired, try again' }));
      }
      try {
        const user = await ctx.github.exchangeCode(req.query.code, `${base(ctx)}/auth/github/callback`);
        if (!ctx.github.isAdmin(user.login)) {
          req.log.warn({ login: user.login }, 'sign-in refused: account not allowed');
          return reply.redirect(
            toUi(ctx, '/', { auth_error: `the GitHub account ${user.login} is not allowed on this Catalyst` }),
          );
        }
        await createSession(ctx, reply, user);
        req.log.info({ login: user.login }, 'signed in');
        return reply.redirect(toUi(ctx, '/'));
      } catch (err) {
        req.log.error({ err }, 'GitHub sign-in failed');
        return reply.redirect(toUi(ctx, '/', { auth_error: 'GitHub sign-in failed' }));
      }
    },
  );

  // --- Création de la GitHub App (flux « manifest ») ---

  app.get<{ Querystring: { code?: string; state?: string } }>('/auth/github/app-created', async (req, reply) => {
    const { code, state } = req.query;
    const exp = state ? manifestStates.get(state) : undefined;
    if (!code || !state || !exp || exp < Date.now()) {
      return reply.redirect(toUi(ctx, '/settings', { error: 'GitHub App creation expired, start again' }));
    }
    manifestStates.delete(state);
    try {
      const creds = await ctx.github.convertManifest(code);
      ctx.github.saveApp(creds);
      req.log.info({ app: creds.slug, owner: creds.owner }, 'GitHub App created');
      // Étape suivante : installer l'App sur les repos à déployer.
      return reply.redirect(`${creds.htmlUrl}/installations/new`);
    } catch (err) {
      req.log.error({ err }, 'GitHub manifest conversion failed');
      return reply.redirect(toUi(ctx, '/settings', { error: 'GitHub App creation failed' }));
    }
  });

  // Après installation (ou modification) de l'App sur des repos.
  app.get('/auth/github/installed', async (_req, reply) => reply.redirect(toUi(ctx, '/new', { installed: '1' })));
}
