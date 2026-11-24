import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';

export const SESSION_COOKIE = 'catalyst_session';
const SESSION_DAYS = 30;

export interface AuthUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  via: 'session' | 'token';
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const hashHex = (value: string) => sha256(value).toString('hex');

export function isAdminToken(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  return timingSafeEqual(sha256(m[1]!), sha256(token));
}

export function cookieOptions(ctx: Ctx, maxAgeSeconds: number) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: ctx.env.PUBLIC_URL.startsWith('https://'),
    maxAge: maxAgeSeconds,
  };
}

export async function createSession(
  ctx: Ctx,
  reply: FastifyReply,
  user: { login: string; id: number; name: string | null; avatarUrl: string },
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await ctx.db.query(
    `INSERT INTO sessions (id_hash, login, github_id, name, avatar_url, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
    [hashHex(token), user.login, user.id, user.name, user.avatarUrl, SESSION_DAYS],
  );
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(ctx, SESSION_DAYS * 86400));
}

export async function destroySession(ctx: Ctx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await ctx.db.query('DELETE FROM sessions WHERE id_hash = $1', [hashHex(token)]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * Identifie l'appelant : token admin (CLI, `Authorization: Bearer`) ou session navigateur.
 * Une session n'est valable que si son compte GitHub est toujours dans la liste des admins.
 */
export async function authenticate(ctx: Ctx, req: FastifyRequest): Promise<AuthUser | null> {
  if (isAdminToken(req.headers.authorization, ctx.env.ADMIN_TOKEN)) {
    return { login: 'admin', name: 'Token admin', avatarUrl: null, via: 'token' };
  }
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await ctx.db.query<{ login: string; name: string | null; avatar_url: string | null }>(
    'SELECT login, name, avatar_url FROM sessions WHERE id_hash = $1 AND expires_at > now()',
    [hashHex(token)],
  );
  const s = rows[0];
  if (!s || !ctx.github.isAdmin(s.login)) return null;
  return { login: s.login, name: s.name, avatarUrl: s.avatar_url, via: 'session' };
}

/**
 * Protection CSRF des requêtes authentifiées par cookie : une écriture doit venir
 * de l'interface elle-même (en-tête Origin = PUBLIC_URL), en plus de SameSite=Lax.
 */
export function isSameOrigin(ctx: Ctx, req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (origin) return origin === new URL(ctx.env.PUBLIC_URL).origin;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}
