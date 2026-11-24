import { promises as dns } from 'node:dns';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  activeConfigs,
  allHosts,
  findConflicts,
  parseProjectInput,
  type ProjectConfig,
} from '../config/projects.js';
import { siteScheme } from '../config/env.js';
import type { Ctx } from '../context.js';
import { tx } from '../db/client.js';
import type { ProjectRow } from '../db/schema.js';
import { removeContainer } from '../docker/client.js';
import { parseEnvFile, serializeEnvFile } from '../docker/spec.js';
import { getBranchHead, splitRepo } from '../github/client.js';
import { RepoAccessError } from '../github/service.js';
import { DetectError, detect } from '../build/detect.js';
import { githubSource } from '../build/sources.js';
import { listBranchesByActivity, listRecentCommits } from '../github/branches.js';
import { appManifest, issueManifestState, isLocalHost, publicWebhookUrl } from '../auth/routes.js';
import { discordWebhookUrl, postDiscord } from '../notify/discord.js';
import { DISCORD_WEBHOOK_RE, maskWebhook } from '../settings.js';
import { HttpError } from './errors.js';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ghStatus(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

async function getProject(ctx: Ctx, slug: string): Promise<ProjectRow> {
  const { rows } = await ctx.db.query<ProjectRow>('SELECT * FROM projects WHERE slug = $1', [slug]);
  if (!rows[0]) throw new HttpError(404, `unknown project: ${slug}`);
  return rows[0];
}

function assertEditable(project: ProjectRow): void {
  if (project.managed_by === 'file') {
    throw new HttpError(409, `${project.slug} is defined in projects.yml: edit the file, then restart Catalyst`);
  }
}

function validate(ctx: Ctx, raw: unknown): ProjectConfig {
  try {
    return parseProjectInput(raw, ctx.env.BASE_DOMAIN);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

async function repoClient(ctx: Ctx, repo: string) {
  try {
    return (await ctx.github.forRepo(repo)).octokit;
  } catch (err) {
    if (err instanceof RepoAccessError) throw new HttpError(400, err.message);
    throw err;
  }
}

/** Vérifie que Catalyst (GitHub App ou token) voit le repo et la branche. */
async function checkRepoAccess(ctx: Ctx, config: ProjectConfig): Promise<void> {
  const { owner, name } = splitRepo(config.repo);
  const octokit = await repoClient(ctx, config.repo);
  try {
    await octokit.rest.repos.get({ owner, repo: name });
  } catch (err) {
    if (ghStatus(err) === 404 || ghStatus(err) === 403) {
      throw new HttpError(400, `repo ${config.repo} not found or not accessible to Catalyst`);
    }
    throw err;
  }
  try {
    await getBranchHead(octokit, config.repo, config.branch);
  } catch (err) {
    if (ghStatus(err) === 404 || ghStatus(err) === 422) {
      throw new HttpError(400, `branch ${config.branch} not found in ${config.repo}`);
    }
    throw err;
  }
}

async function assertNoConflict(ctx: Ctx, config: ProjectConfig, exceptSlug?: string): Promise<void> {
  const conflicts = findConflicts(config, await activeConfigs(ctx.db, exceptSlug));
  if (conflicts.length > 0) throw new HttpError(409, conflicts.map((c) => c.reason).join(' ; '));
}

function envFile(ctx: Ctx, slug: string): string {
  return join(ctx.env.SECRETS_DIR, `${slug}.env`);
}

async function resolveAll(host: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    dns.resolve4(host).catch(() => [] as string[]),
    dns.resolve6(host).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

/** IP(s) attendue(s) : SERVER_IP, sinon celles du domaine de la plateforme. */
async function serverIps(ctx: Ctx): Promise<string[]> {
  if (ctx.env.SERVER_IP) return [ctx.env.SERVER_IP];
  return resolveAll(new URL(ctx.env.PUBLIC_URL).hostname);
}

function webhookUrl(ctx: Ctx): string {
  return publicWebhookUrl(ctx) ?? `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/webhooks/github`;
}

interface HookInfo {
  id: number;
  active: boolean;
  config: { url?: string };
  events: string[];
  last_response?: { code: number | null; status: string | null; message: string | null };
}

async function findHook(ctx: Ctx, repo: string): Promise<HookInfo | null> {
  const { owner, name } = splitRepo(repo);
  const octokit = await repoClient(ctx, repo);
  const hooks = (await octokit.paginate(octokit.rest.repos.listWebhooks, {
    owner,
    repo: name,
    per_page: 100,
  })) as HookInfo[];
  return hooks.find((h) => h.config.url === webhookUrl(ctx)) ?? null;
}

function hookPermissionError(err: unknown): HttpError | null {
  const status = ghStatus(err);
  if (status === 403 || status === 404) {
    return new HttpError(
      400,
      'the GitHub token lacks the "Webhooks: read and write" permission on this repo ' +
        '(or add the webhook manually: see the instructions)',
    );
  }
  return null;
}

/** Routes de gestion utilisées par l'interface web (préfixe /api, auth déjà vérifiée). */
export async function adminRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get('/meta', async () => ({
    baseDomain: ctx.env.BASE_DOMAIN,
    publicUrl: ctx.env.PUBLIC_URL,
    webhookUrl: webhookUrl(ctx),
    serverIps: await serverIps(ctx),
    siteScheme: siteScheme(ctx.env),
    github: {
      mode: ctx.github.mode,
      app: ctx.github.app ? { slug: ctx.github.app.slug, name: ctx.github.app.name, owner: ctx.github.app.owner } : null,
      installUrl: ctx.github.installUrl(),
      // false en local sans relais : les commits sont détectés par polling uniquement.
      webhooks: publicWebhookUrl(ctx) !== null,
      pollSeconds: ctx.env.POLL_INTERVAL_SECONDS,
    },
  }));

  // --- Réglages : GitHub App et admins ---

  app.get('/settings', async () => ({
    github: {
      mode: ctx.github.mode,
      app: ctx.github.app
        ? { slug: ctx.github.app.slug, name: ctx.github.app.name, owner: ctx.github.app.owner, htmlUrl: ctx.github.app.htmlUrl }
        : null,
      installUrl: ctx.github.installUrl(),
    },
    admins: ctx.github.app?.admins ?? [],
    envAdmins: (ctx.env.CATALYST_ADMINS ?? '').split(/[\s,]+/).filter(Boolean),
  }));

  // --- Notifications Discord ---

  const notificationsView = () => {
    const d = ctx.settings.get().discord;
    const active = d.webhookUrl ?? ctx.env.DISCORD_WEBHOOK_URL ?? null;
    return {
      discord: {
        configured: active !== null,
        // Jamais l'URL complète : elle suffit pour poster dans le salon.
        webhookMasked: active ? maskWebhook(active) : null,
        fromEnv: !d.webhookUrl && !!ctx.env.DISCORD_WEBHOOK_URL,
        onSuccess: d.onSuccess,
        onFailure: d.onFailure,
        onIncident: d.onIncident,
      },
    };
  };

  app.get('/settings/notifications', async () => notificationsView());

  app.put<{
    Body: { discord?: { webhookUrl?: string | null; onSuccess?: boolean; onFailure?: boolean; onIncident?: boolean } };
  }>('/settings/notifications', async (req) => {
    const d = req.body?.discord ?? {};
    const patch: Record<string, unknown> = {};
    if (d.webhookUrl !== undefined) {
      const url = typeof d.webhookUrl === 'string' ? d.webhookUrl.trim() : null;
      if (url && !DISCORD_WEBHOOK_RE.test(url)) {
        throw new HttpError(400, 'invalid Discord webhook URL (https://discord.com/api/webhooks/…)');
      }
      patch.webhookUrl = url || null;
    }
    for (const key of ['onSuccess', 'onFailure', 'onIncident'] as const) {
      if (d[key] !== undefined) {
        if (typeof d[key] !== 'boolean') throw new HttpError(400, `${key} must be a boolean`);
        patch[key] = d[key];
      }
    }
    ctx.settings.update({ discord: patch });
    return notificationsView();
  });

  app.post('/settings/notifications/test', async () => {
    const url = discordWebhookUrl(ctx);
    if (!url) throw new HttpError(409, 'no Discord webhook configured');
    const result = await postDiscord(url, {
      embeds: [
        {
          title: '🔔 Catalyst is connected',
          description: `Notifications from ${new URL(ctx.env.PUBLIC_URL).host} will be posted in this channel.`,
          color: 0x3b82f6,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    if (!result.ok) throw new HttpError(502, result.error ?? 'could not send');
    return { ok: true };
  });

  app.put<{ Body: { admins?: unknown } }>('/settings/admins', async (req) => {
    const admins = req.body?.admins;
    if (!Array.isArray(admins) || admins.some((a) => typeof a !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(a))) {
      throw new HttpError(400, 'expected admins: a list of GitHub logins');
    }
    if (!ctx.github.app) throw new HttpError(409, 'create the GitHub App first');
    ctx.github.setAdmins(admins as string[]);
    return { admins: ctx.github.app.admins };
  });

  /** Prépare le formulaire de création de la GitHub App (soumis par le navigateur vers github.com). */
  app.post<{ Body: { org?: string } | null }>('/github/app/manifest', async (req) => {
    const org = req.body?.org?.trim();
    if (org && !/^[A-Za-z0-9-]{1,39}$/.test(org)) throw new HttpError(400, 'invalid organization name');
    const state = issueManifestState();
    const action = org
      ? `https://github.com/organizations/${org}/settings/apps/new?state=${state}`
      : `https://github.com/settings/apps/new?state=${state}`;
    return { action, manifest: appManifest(ctx) };
  });

  // --- GitHub : import de repos ---

  app.get('/github/repos', async () => ctx.github.listRepos());

  app.get<{ Params: { owner: string; repo: string } }>('/github/repos/:owner/:repo/branches', async (req) => {
    const repo = `${req.params.owner}/${req.params.repo}`;
    const octokit = await repoClient(ctx, repo);
    try {
      return await listBranchesByActivity(octokit, repo);
    } catch (err) {
      if (ghStatus(err) === 404 || ghStatus(err) === 403) throw new HttpError(404, 'repo not accessible');
      throw err;
    }
  });

  /** Derniers commits de la branche suivie (ou d'une autre), pour choisir quoi déployer. */
  app.get<{ Params: { slug: string }; Querystring: { branch?: string } }>('/projects/:slug/commits', async (req) => {
    const project = await getProject(ctx, req.params.slug);
    const octokit = await repoClient(ctx, project.repo);
    try {
      return await listRecentCommits(octokit, project.repo, req.query.branch || project.branch);
    } catch (err) {
      if (ghStatus(err) === 404 || ghStatus(err) === 409) throw new HttpError(404, 'branch not found');
      throw err;
    }
  });

  /**
   * Aperçu à l'import : Dockerfile du repo (et son port EXPOSE) ou, à défaut, stack détectée
   * automatiquement, avec la commande de build/démarrage et le port proposés.
   */
  app.get<{ Params: { owner: string; repo: string }; Querystring: { ref?: string; path?: string; context?: string } }>(
    '/github/repos/:owner/:repo/inspect',
    async (req) => {
      const { owner, repo } = req.params;
      const fullName = `${owner}/${repo}`;
      const octokit = await repoClient(ctx, fullName);
      let ref = req.query.ref;
      if (!ref) ref = (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
      const src = githubSource(octokit, fullName, ref, req.query.context || '.');

      const dockerfile = await src.read(req.query.path || 'Dockerfile');
      if (dockerfile !== null) {
        const expose = /^\s*EXPOSE\s+(\d+)/im.exec(dockerfile);
        return { dockerfile: true, port: expose ? Number(expose[1]) : null, detected: null, error: null };
      }
      try {
        const d = await detect(src);
        return {
          dockerfile: false,
          port: d.port,
          detected: { stack: d.stack, label: d.label, build: d.build ?? null, start: d.start ?? null, notes: d.notes },
          error: null,
        };
      } catch (err) {
        if (err instanceof DetectError) return { dockerfile: false, port: null, detected: null, error: err.message };
        throw err;
      }
    },
  );

  // --- Projets ---

  app.post<{ Body: unknown }>('/projects', async (req, reply) => {
    const config = validate(ctx, req.body);
    const { rows: existing } = await ctx.db.query<ProjectRow>('SELECT * FROM projects WHERE slug = $1', [config.slug]);
    const previous = existing[0];
    if (previous && (previous.enabled || previous.managed_by === 'file')) {
      throw new HttpError(409, `slug ${config.slug} is already taken`);
    }
    await assertNoConflict(ctx, config, config.slug);
    await checkRepoAccess(ctx, config);

    // Un projet supprimé depuis l'interface peut être recréé avec le même slug.
    await ctx.db.query(
      `INSERT INTO projects (slug, repo, branch, config, managed_by)
       VALUES ($1, $2, $3, $4, 'ui')
       ON CONFLICT (slug) DO UPDATE SET
         repo = EXCLUDED.repo, branch = EXCLUDED.branch, config = EXCLUDED.config,
         enabled = true, paused = false, last_seen_sha = NULL, github_etag = NULL,
         current_deployment_id = NULL, updated_at = now()`,
      [config.slug, config.repo, config.branch, JSON.stringify(config)],
    );
    return reply.code(201).send({ slug: config.slug, config });
  });

  app.put<{ Params: { slug: string }; Body: Record<string, unknown> }>('/projects/:slug', async (req) => {
    const project = await getProject(ctx, req.params.slug);
    assertEditable(project);
    if (!project.enabled) throw new HttpError(409, 'project deleted');
    // Le slug ne change jamais : il nomme les conteneurs, les images et le fichier de secrets.
    const config = validate(ctx, { ...(req.body ?? {}), slug: project.slug });
    await assertNoConflict(ctx, config, project.slug);
    const sourceChanged = config.repo !== project.repo || config.branch !== project.branch;
    if (sourceChanged) await checkRepoAccess(ctx, config);

    await ctx.db.query(
      `UPDATE projects SET repo = $2, branch = $3, config = $4, updated_at = now(),
              last_seen_sha = CASE WHEN $5 THEN NULL ELSE last_seen_sha END,
              github_etag   = CASE WHEN $5 THEN NULL ELSE github_etag END
        WHERE id = $1`,
      [project.id, config.repo, config.branch, JSON.stringify(config), sourceChanged],
    );
    return { slug: project.slug, config, redeployNeeded: true };
  });

  app.delete<{ Params: { slug: string } }>('/projects/:slug', async (req) => {
    const project = await getProject(ctx, req.params.slug);
    assertEditable(project);
    await tx(ctx.db, async (c) => {
      await c.query(
        `UPDATE projects SET enabled = false, paused = false, last_seen_sha = NULL, github_etag = NULL,
                current_deployment_id = NULL, updated_at = now()
          WHERE id = $1`,
        [project.id],
      );
      await c.query(
        `UPDATE deployments SET status = 'cancelled', error = 'project deleted', finished_at = now()
          WHERE project_id = $1 AND status = 'queued'`,
        [project.id],
      );
      await c.query(`UPDATE jobs SET state = 'cancelled' WHERE project_id = $1 AND state = 'pending'`, [project.id]);
      await c.query(
        `UPDATE jobs SET cancel_requested = 'cancelled' WHERE project_id = $1 AND state = 'running'`,
        [project.id],
      );
    });
    // Arrêt du site (l'historique et les images restent ; le nettoyage quotidien s'en occupe).
    const containers = await ctx.docker
      .listContainers({ all: true, filters: { label: [`catalyst.project=${project.slug}`] } })
      .catch(() => []);
    for (const c of containers) {
      const name = (c.Names[0] ?? '').replace(/^\//, '');
      await removeContainer(ctx.docker, name, 10).catch((err) =>
        req.log.warn({ err, container: name }, 'could not remove container'),
      );
    }
    return { slug: project.slug, deleted: true };
  });

  // --- Variables d'environnement runtime (${SECRETS_DIR}/<slug>.env, chmod 600) ---

  app.get<{ Params: { slug: string } }>('/projects/:slug/env', async (req) => {
    const project = await getProject(ctx, req.params.slug);
    const file = envFile(ctx, project.slug);
    const lines = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : [];
    return {
      vars: lines.map((l) => {
        const i = l.indexOf('=');
        return { key: l.slice(0, i), value: l.slice(i + 1) };
      }),
    };
  });

  app.put<{ Params: { slug: string }; Body: { vars?: { key: string; value: string }[] } }>(
    '/projects/:slug/env',
    async (req) => {
      const project = await getProject(ctx, req.params.slug);
      const vars = req.body?.vars;
      if (!Array.isArray(vars)) throw new HttpError(400, 'expected vars: [{ key, value }]');
      const seen = new Set<string>();
      for (const v of vars) {
        if (typeof v?.key !== 'string' || !ENV_KEY.test(v.key)) {
          throw new HttpError(400, `invalid variable name: ${String(v?.key)}`);
        }
        if (typeof v.value !== 'string') throw new HttpError(400, `invalid value for ${v.key}`);
        if (seen.has(v.key)) throw new HttpError(400, `duplicate variable: ${v.key}`);
        seen.add(v.key);
      }
      mkdirSync(ctx.env.SECRETS_DIR, { recursive: true, mode: 0o700 });
      const file = envFile(ctx, project.slug);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, serializeEnvFile(vars), { mode: 0o600 });
      renameSync(tmp, file);
      return { count: vars.length, redeployNeeded: true };
    },
  );

  // --- Webhook GitHub ---

  app.get<{ Params: { slug: string } }>('/projects/:slug/webhook', async (req) => {
    const project = await getProject(ctx, req.params.slug);
    if (ctx.github.mode === 'app') {
      // Un seul webhook, celui de la GitHub App, couvre tous les repos où elle est installée.
      const installed = await ctx.github.forRepo(project.repo).then(
        () => true,
        () => false,
      );
      return { url: webhookUrl(ctx), mode: 'app', configured: installed, active: installed };
    }
    try {
      const hook = await findHook(ctx, project.repo);
      if (!hook) return { url: webhookUrl(ctx), configured: false };
      return {
        url: webhookUrl(ctx),
        configured: true,
        active: hook.active,
        events: hook.events,
        lastResponse: hook.last_response ?? null,
      };
    } catch (err) {
      const permission = hookPermissionError(err);
      if (permission) return { url: webhookUrl(ctx), configured: null, error: permission.message };
      throw err;
    }
  });

  app.post<{ Params: { slug: string } }>('/projects/:slug/webhook', async (req) => {
    const project = await getProject(ctx, req.params.slug);
    if (ctx.github.mode === 'app') {
      throw new HttpError(409, 'webhooks are handled by the GitHub App: add the repo to its installation');
    }
    if (!ctx.env.GITHUB_WEBHOOK_SECRET) throw new HttpError(409, 'GITHUB_WEBHOOK_SECRET is not set on the server');
    const { owner, name } = splitRepo(project.repo);
    const octokit = await repoClient(ctx, project.repo);
    const config = {
      url: webhookUrl(ctx),
      content_type: 'json' as const,
      secret: ctx.env.GITHUB_WEBHOOK_SECRET,
      insecure_ssl: '0' as const,
    };
    try {
      const existing = await findHook(ctx, project.repo);
      let id: number;
      if (existing) {
        await octokit.rest.repos.updateWebhook({
          owner,
          repo: name,
          hook_id: existing.id,
          config,
          events: ['push'],
          active: true,
        });
        id = existing.id;
      } else {
        const { data } = await octokit.rest.repos.createWebhook({
          owner,
          repo: name,
          config,
          events: ['push'],
          active: true,
        });
        id = data.id;
      }
      await octokit.rest.repos.pingWebhook({ owner, repo: name, hook_id: id }).catch(() => {});
      return { configured: true, id, created: !existing };
    } catch (err) {
      throw hookPermissionError(err) ?? err;
    }
  });

  // --- Contrôle DNS (utile pour un domaine racine, non couvert par le wildcard *.domaine) ---

  app.get<{ Params: { slug: string } }>('/projects/:slug/dns', async (req) => {
    const project = await getProject(ctx, req.params.slug);
    const expected = await serverIps(ctx);
    const hosts = await Promise.all(
      allHosts(project.config).map(async (host) => {
        // *.localhost pointe toujours vers la machine locale : rien à configurer.
        if (isLocalHost(host)) return { host, ips: ['127.0.0.1'], status: 'ok' as const, apex: false };
        const ips = await resolveAll(host);
        const status =
          ips.length === 0
            ? 'missing'
            : expected.length === 0
              ? 'unknown'
              : ips.some((ip) => expected.includes(ip))
                ? 'ok'
                : 'mismatch';
        return { host, ips, status, apex: host.split('.').length === 2 };
      }),
    );
    return { expected, hosts };
  });
}
