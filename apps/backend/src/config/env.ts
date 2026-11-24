import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const envSchema = z.object({
  // Serveur
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().url(),
  BASE_DOMAIN: z.string().min(1),

  // Base de données
  DATABASE_URL: z.string().min(1),

  // GitHub : de préférence une GitHub App créée depuis l'interface (stockée dans DATA_DIR).
  // Repli : token personnel + webhooks configurés repo par repo.
  GITHUB_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  GITHUB_WEBHOOK_SECRET: z.preprocess(
    emptyToUndefined,
    z.string().min(16, 'at least 16 characters (openssl rand -hex 32)').optional(),
  ),
  // Comptes GitHub autorisés à se connecter à l'interface (séparés par des virgules).
  CATALYST_ADMINS: z.preprocess(emptyToUndefined, z.string().optional()),
  // URL publique à laquelle GitHub envoie les webhooks, si différente de PUBLIC_URL/webhooks/github
  // (en local : un relais type https://smee.io/xxx qui renvoie vers Catalyst).
  GITHUB_WEBHOOK_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),

  // API interne
  ADMIN_TOKEN: z.string().min(16, 'at least 16 characters'),

  // Comportement
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(600),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  KEEP_IMAGES: z.coerce.number().int().min(1).default(3),
  BUILD_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(900),
  HEALTHCHECK_TIMEOUT_SECONDS: z.coerce.number().int().min(5).default(60),

  // Chemins
  DATA_DIR: z.string().default('/var/lib/catalyst'),
  WORKDIR: z.string().default('/var/lib/catalyst/repos'),
  SECRETS_DIR: z.string().default('/var/lib/catalyst/env'),
  PROJECTS_FILE: z.string().default('./projects.yml'),

  // Docker / Traefik
  DOCKER_NETWORK: z.string().default('catalyst-net'),
  TRAEFIK_ENTRYPOINT: z.string().default('websecure'),
  // Vide = pas de HTTPS (test en local, entrypoint `web`).
  TRAEFIK_CERT_RESOLVER: z.preprocess((v) => (v === undefined ? 'le' : v), z.string()),

  // Interface web : dossier du front compilé (défaut : <app>/web) ; IP publique du serveur pour le contrôle DNS
  WEB_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  SERVER_IP: z.preprocess(emptyToUndefined, z.string().ip().optional()),

  // Notifications : se règle dans l'interface (Réglages) ; cette variable ne sert que de valeur par défaut.
  DISCORD_WEBHOOK_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),

  // Découpage en process (plan §3) : all = receiver + poller + worker dans le même process
  ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

/** Les sites sont servis en HTTPS seulement si Traefik a un résolveur de certificats (sinon : mode local, HTTP). */
export function siteScheme(env: Pick<Env, 'TRAEFIK_CERT_RESOLVER'>): 'http' | 'https' {
  return env.TRAEFIK_CERT_RESOLVER ? 'https' : 'http';
}

export function siteUrl(env: Pick<Env, 'TRAEFIK_CERT_RESOLVER'>, host: string): string {
  return `${siteScheme(env)}://${host}`;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration (environment variables):\n${lines.join('\n')}`);
  }
  return result.data;
}
