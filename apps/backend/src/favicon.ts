import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './context.js';
import type { DeploymentRow, ProjectRow } from './db/schema.js';
import { inspectContainer } from './docker/client.js';

/**
 * Favicon des sites déployés : récupéré sur le conteneur en ligne après une mise en ligne
 * (ou à la première demande), mis en cache dans DATA_DIR/favicons, affiché par l'interface.
 * Une API sans page HTML n'a pas de favicon : l'interface garde l'initiale du projet.
 */

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 4_000;
const RETRY_AFTER_MS = 5 * 60_000;

interface FaviconMeta {
  deploymentId: number;
  /** null : le site n'a pas de favicon (ou n'est pas un site HTML). */
  contentType: string | null;
  capturedAt: string;
}

const dir = (ctx: Ctx) => join(ctx.env.DATA_DIR, 'favicons');
const metaPath = (ctx: Ctx, slug: string) => join(dir(ctx), `${slug}.json`);
const dataPath = (ctx: Ctx, slug: string) => join(dir(ctx), `${slug}.bin`);

/** Type réel d'une image d'après ses premiers octets (on ne se fie pas à l'en-tête du serveur). */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

/** Liens d'icône d'une page HTML, du plus adapté au moins adapté. */
export function iconLinks(html: string): string[] {
  const found: { href: string; score: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    const relM = attr('rel');
    const hrefM = attr('href');
    if (!relM || !hrefM) continue;
    const rel = (relM[1] ?? relM[2] ?? relM[3] ?? '').toLowerCase().split(/\s+/);
    const href = (hrefM[1] ?? hrefM[2] ?? hrefM[3] ?? '').trim();
    if (!href) continue;
    const type = (attr('type')?.[1] ?? '').toLowerCase();
    if (rel.includes('icon')) {
      const svg = type.includes('svg') || /\.svg(\?|$)/i.test(href);
      found.push({ href, score: svg ? 3 : 2 });
    } else if (rel.includes('apple-touch-icon')) {
      found.push({ href, score: 1 });
    }
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.href);
}

async function fetchLimited(url: string): Promise<{ status: number; type: string; body: Buffer } | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) {
      await res.body?.cancel();
      return null;
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_BYTES) return null;
    return { status: res.status, type: res.headers.get('content-type') ?? '', body };
  } catch {
    return null;
  }
}

function decodeDataUri(uri: string): Buffer | null {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  try {
    return m[1] ? Buffer.from(m[2]!, 'base64') : Buffer.from(decodeURIComponent(m[2]!));
  } catch {
    return null;
  }
}

/** Cherche l'icône du site servi par `base` (URL interne du conteneur). */
export async function findFavicon(
  base: string,
  domains: string[],
  fetcher = fetchLimited,
): Promise<{ type: string; body: Buffer } | null> {
  const candidates: string[] = [];
  const page = await fetcher(`${base}/`);
  if (page && page.status < 400 && /html/i.test(page.type)) {
    candidates.push(...iconLinks(page.body.toString('utf8')));
  }
  candidates.push('/favicon.ico');

  for (const href of candidates) {
    let body: Buffer | null = null;
    if (href.startsWith('data:')) {
      body = decodeDataUri(href);
    } else {
      let url: URL;
      try {
        url = new URL(href, `${base}/`);
      } catch {
        continue;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      // Lien absolu vers le domaine du site : on passe par le conteneur (pas de DNS en local).
      if (domains.includes(url.hostname)) url = new URL(`${url.pathname}${url.search}`, `${base}/`);
      const res = await fetcher(url.toString());
      if (res && res.status < 400) body = res.body;
    }
    const type = body ? sniffImage(body) : null;
    if (body && type) return { type, body };
  }
  return null;
}

function writeMeta(ctx: Ctx, slug: string, meta: FaviconMeta, body?: Buffer): void {
  mkdirSync(dir(ctx), { recursive: true });
  if (body) {
    writeFileSync(`${dataPath(ctx, slug)}.tmp`, body);
    renameSync(`${dataPath(ctx, slug)}.tmp`, dataPath(ctx, slug));
  }
  writeFileSync(metaPath(ctx, slug), JSON.stringify(meta));
}

function readMeta(ctx: Ctx, slug: string): FaviconMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(ctx, slug), 'utf8')) as FaviconMeta;
  } catch {
    return null;
  }
}

/** Capture le favicon du conteneur en ligne d'un déploiement. Ne lève jamais. */
export async function captureFavicon(ctx: Ctx, project: ProjectRow, deployment: DeploymentRow): Promise<boolean> {
  try {
    if (!deployment.container_name) return false;
    const info = await inspectContainer(ctx.docker, deployment.container_name);
    const ip = info?.NetworkSettings.Networks[ctx.env.DOCKER_NETWORK]?.IPAddress;
    if (!ip || !info?.State.Running) return false;
    const icon = await findFavicon(`http://${ip}:${project.config.port}`, project.config.domains);
    const meta: FaviconMeta = {
      deploymentId: deployment.id,
      contentType: icon?.type ?? null,
      capturedAt: new Date().toISOString(),
    };
    writeMeta(ctx, project.slug, meta, icon?.body);
    return true;
  } catch (err) {
    ctx.log.warn({ err, project: project.slug }, 'could not fetch favicon');
    return false;
  }
}

/** GET /favicons/:slug — public (une icône de site public), pour être utilisable dans <img>. */
export async function faviconRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const lastAttempt = new Map<string, number>();
  const inflight = new Map<string, Promise<boolean>>();

  app.get<{ Params: { slug: string } }>('/favicons/:slug', async (req, reply) => {
    const slug = req.params.slug;
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug)) return reply.code(404).send();

    let meta = readMeta(ctx, slug);
    const { rows } = await ctx.db.query<ProjectRow & { deployment: DeploymentRow | null }>(
      `SELECT p.*, to_jsonb(d) AS deployment FROM projects p
         LEFT JOIN deployments d ON d.id = p.current_deployment_id
        WHERE p.slug = $1 AND p.enabled`,
      [slug],
    );
    const project = rows[0];
    const live = project?.deployment;

    // Pas encore capturé pour la version en ligne : on essaie maintenant (au plus toutes les 5 min).
    if (project && live && !project.stopped && meta?.deploymentId !== live.id) {
      const last = lastAttempt.get(slug) ?? 0;
      if (Date.now() - last > RETRY_AFTER_MS) {
        lastAttempt.set(slug, Date.now());
        let p = inflight.get(slug);
        if (!p) {
          p = captureFavicon(ctx, project, live).finally(() => inflight.delete(slug));
          inflight.set(slug, p);
        }
        await p;
        meta = readMeta(ctx, slug);
      }
    }

    if (!meta?.contentType || !existsSync(dataPath(ctx, slug))) {
      return reply.code(404).header('cache-control', 'no-store').send();
    }
    return reply
      .header('content-type', meta.contentType)
      .header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff')
      // Un SVG ouvert directement ne doit jamais pouvoir exécuter de script sur l'origine de Catalyst.
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .send(readFileSync(dataPath(ctx, slug)));
  });
}
