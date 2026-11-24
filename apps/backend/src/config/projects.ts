import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Db, Queryable } from '../db/client.js';

/** Chemin relatif dans le repo, sans remontée (`..`) ni chemin absolu. */
const repoPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[a-zA-Z]:/.test(p) && !p.split(/[\\/]/).includes('..'), {
    message: 'must be a relative path inside the repo, without ".."',
  });

/** Domaine racine (mondomaine.fr) ou sous-domaine (app.mondomaine.fr). */
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, 'invalid domain name');

export const projectSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/, 'must match ^[a-z0-9][a-z0-9-]{1,30}$'),
    repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'must look like owner/name'),
    branch: z.string().trim().min(1).default('main'),
    // Utilisé s'il existe dans le repo ; sinon Catalyst détecte la stack et génère un Dockerfile.
    dockerfile: repoPath.default('Dockerfile'),
    // Surcharges de la détection automatique (sans effet avec un Dockerfile du repo).
    build_command: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(500).optional()),
    start_command: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(500).optional()),
    context: repoPath.default('.'),
    port: z.number().int().min(1).max(65535),
    domains: z.array(hostname).min(1).optional(),
    // Ajoute www.<domaine> qui redirige (301) vers <domaine>, pour chaque domaine ne commençant pas par www.
    www_redirect: z.boolean().default(false),
    healthcheck: z
      .object({
        path: z.string().startsWith('/').default('/'),
        timeout_seconds: z.number().int().min(5).optional(),
        // docker : healthcheck Docker + bascule sans coupure (nécessite wget ou curl dans l'image)
        // worker : test HTTP fait par la plateforme puis recréation du conteneur routé (~1 s de coupure)
        mode: z.enum(['docker', 'worker']).default('docker'),
      })
      .strict()
      .default({}),
    resources: z
      .object({
        memory: z.string().regex(/^\d+(\.\d+)?[bkmg]?$/i, 'e.g. 512m, 1g').default('512m'),
        cpus: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d+(\.\d+)?$/)).default('0.5'),
      })
      .strict()
      .default({}),
    build_args: z.record(z.union([z.string(), z.number(), z.boolean()]).transform(String)).default({}),
    deploy_on_first_seen: z.boolean().default(true),
  })
  .strict();

const fileSchema = z.object({ projects: z.array(projectSchema).nullish() }).strict();

export type ProjectInput = z.infer<typeof projectSchema>;
export type ProjectConfig = Omit<ProjectInput, 'domains'> & { domains: string[] };

function formatIssues(prefix: string, issues: z.ZodIssue[]): string {
  return `${prefix}:\n${issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`;
}

function withDefaults(p: ProjectInput, baseDomain: string): ProjectConfig {
  const domains = p.domains ?? [`${p.slug}.${baseDomain}`];
  return { ...p, domains: [...new Set(domains)] };
}

/** Hôtes www.* ajoutés par `www_redirect`. */
export function wwwRedirectHosts(p: Pick<ProjectConfig, 'domains' | 'www_redirect'>): string[] {
  if (!p.www_redirect) return [];
  return p.domains.filter((d) => !d.startsWith('www.')).map((d) => `www.${d}`).filter((d) => !p.domains.includes(d));
}

/** Tous les hôtes servis par un projet (domaines + redirections www). */
export function allHosts(p: Pick<ProjectConfig, 'domains' | 'www_redirect'>): string[] {
  return [...p.domains, ...wwwRedirectHosts(p)];
}

/** Valide un projet seul (création / modification depuis l'API). */
export function parseProjectInput(raw: unknown, baseDomain: string): ProjectConfig {
  const result = projectSchema.safeParse(raw);
  if (!result.success) throw new Error(formatIssues('invalid project', result.error.issues));
  return withDefaults(result.data, baseDomain);
}

export interface Conflict {
  slug: string;
  reason: string;
}

/** Doublons de slug, de couple repo/branche ou d'hôte entre projets. */
export function findConflicts(candidate: ProjectConfig, others: ProjectConfig[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const hosts = new Set(allHosts(candidate));
  for (const o of others) {
    if (o.slug === candidate.slug) conflicts.push({ slug: o.slug, reason: `slug ${o.slug} is already taken` });
    if (o.repo.toLowerCase() === candidate.repo.toLowerCase() && o.branch === candidate.branch) {
      conflicts.push({ slug: o.slug, reason: `${o.repo} (${o.branch}) is already tracked by ${o.slug}` });
    }
    for (const h of allHosts(o)) {
      if (hosts.has(h)) conflicts.push({ slug: o.slug, reason: `domain ${h} is already used by ${o.slug}` });
    }
  }
  return conflicts;
}

export function parseProjects(raw: unknown, baseDomain: string): ProjectConfig[] {
  const result = fileSchema.safeParse(raw ?? {});
  if (!result.success) throw new Error(formatIssues('invalid projects.yml', result.error.issues));

  const projects = (result.data.projects ?? []).map((p) => withDefaults(p, baseDomain));
  const errors: string[] = [];
  projects.forEach((p, i) => {
    for (const c of findConflicts(p, projects.slice(0, i))) {
      errors.push(c.reason.replace(/is already (taken|used by \S+|tracked by \S+)/, 'is duplicated'));
    }
  });
  if (errors.length > 0) {
    throw new Error(`invalid projects.yml:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return projects;
}

/** projects.yml est optionnel : les projets peuvent aussi être créés depuis l'interface web. */
export function loadProjects(file: string, baseDomain: string): ProjectConfig[] {
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
  return parseProjects(raw, baseDomain);
}

/** Configs des projets actifs, hors `exceptSlug` (pour la détection de conflits). */
export async function activeConfigs(db: Queryable, exceptSlug?: string): Promise<ProjectConfig[]> {
  const { rows } = await db.query<{ config: ProjectConfig }>(
    `SELECT config FROM projects WHERE enabled AND slug IS DISTINCT FROM $1`,
    [exceptSlug ?? null],
  );
  return rows.map((r) => r.config);
}

/**
 * Synchronise projects.yml → table `projects` (plan §5.3) : insert/update des projets du fichier,
 * les projets retirés du fichier passent `enabled = false` (jamais supprimés).
 * Les projets créés depuis l'interface (`managed_by = 'ui'`) ne sont pas touchés, sauf si
 * le fichier déclare le même slug : le fichier reprend alors la main.
 */
export async function syncProjects(db: Db, projects: ProjectConfig[]): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const p of projects) {
      await client.query(
        `INSERT INTO projects (slug, repo, branch, config, managed_by)
         VALUES ($1, $2, $3, $4, 'file')
         ON CONFLICT (slug) DO UPDATE SET
           repo = EXCLUDED.repo,
           branch = EXCLUDED.branch,
           config = EXCLUDED.config,
           managed_by = 'file',
           enabled = true,
           -- repo ou branche changé : on repart de zéro pour la détection des commits
           last_seen_sha = CASE WHEN projects.repo = EXCLUDED.repo AND projects.branch = EXCLUDED.branch
                                THEN projects.last_seen_sha END,
           github_etag   = CASE WHEN projects.repo = EXCLUDED.repo AND projects.branch = EXCLUDED.branch
                                THEN projects.github_etag END,
           updated_at = now()`,
        [p.slug, p.repo, p.branch, JSON.stringify(p)],
      );
    }
    await client.query(
      `UPDATE projects SET enabled = false, updated_at = now()
        WHERE enabled AND managed_by = 'file' AND NOT (slug = ANY($1))`,
      [projects.map((p) => p.slug)],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
