import { t } from '../i18n';

// Client de l'API Catalyst (/api/*, Bearer ADMIN_TOKEN).

export type DeploymentStatus =
  | 'queued'
  | 'fetching'
  | 'building'
  | 'starting'
  | 'healthchecking'
  | 'live'
  | 'failed'
  | 'cancelled'
  | 'superseded'
  | 'rolled_back';

export const TERMINAL: DeploymentStatus[] = ['live', 'failed', 'cancelled', 'superseded', 'rolled_back'];
export const isTerminal = (s: DeploymentStatus) => TERMINAL.includes(s);

export interface ProjectConfig {
  slug: string;
  repo: string;
  branch: string;
  dockerfile: string;
  build_command?: string;
  start_command?: string;
  context: string;
  port: number;
  domains: string[];
  www_redirect: boolean;
  healthcheck: { path: string; timeout_seconds?: number; mode: 'docker' | 'worker' };
  resources: { memory: string; cpus: string };
  build_args: Record<string, string>;
  deploy_on_first_seen: boolean;
}

/** Ce que le formulaire envoie (domains absent = sous-domaine par défaut). */
export type ProjectInput = Omit<ProjectConfig, 'domains'> & { domains?: string[] };

export interface Deployment {
  id: number;
  project_id: number;
  sha: string;
  commit_message: string | null;
  commit_author: string | null;
  trigger: 'webhook' | 'poll' | 'manual' | 'rollback';
  status: DeploymentStatus;
  image_tag: string | null;
  container_name: string | null;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  went_live_at: string | null;
}

export interface DeploymentDetail extends Deployment {
  project: { slug: string; repo: string; domains: string[] };
}

export interface Project {
  slug: string;
  repo: string;
  branch: string;
  domains: string[];
  enabled: boolean;
  paused: boolean;
  /** Site arrêté volontairement (le conteneur ne tourne pas). */
  stopped: boolean;
  managedBy: 'file' | 'ui';
  config: ProjectConfig;
  lastSeenSha: string | null;
  currentDeploymentId: number | null;
  live: Deployment | null;
  latest?: Deployment | null;
  recent?: { id: number; status: DeploymentStatus; queued_at: string }[];
}

export interface BranchInfo {
  name: string;
  sha: string;
  date: string | null;
  message: string | null;
  author: string | null;
  isDefault: boolean;
}

export interface CommitInfo {
  sha: string;
  message: string | null;
  author: string | null;
  date: string | null;
}

/** Ligne du fil d'activité (tous projets). */
export interface Activity {
  id: number;
  sha: string;
  status: DeploymentStatus;
  trigger: Deployment['trigger'];
  commit_message: string | null;
  commit_author: string | null;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  slug: string;
  repo: string;
}

/** Aperçu d'un repo à l'import : Dockerfile, ou stack détectée automatiquement. */
export interface RepoInspection {
  dockerfile: boolean;
  port: number | null;
  detected: { stack: string; label: string; build: string | null; start: string | null; notes: string[] } | null;
  error: string | null;
}

export interface GithubInfo {
  mode: 'app' | 'token' | 'none';
  app: { slug: string; name: string; owner: string; htmlUrl?: string } | null;
  installUrl: string | null;
  webhooks?: boolean;
  pollSeconds?: number;
}

export interface Meta {
  siteScheme?: 'http' | 'https';
  baseDomain: string;
  publicUrl: string;
  webhookUrl: string;
  serverIps: string[];
  github: GithubInfo;
}

export interface Settings {
  github: GithubInfo;
  admins: string[];
  envAdmins: string[];
}

export interface User {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  via: 'session' | 'token';
}

export interface Repo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  pushedAt: string | null;
  description: string | null;
}

export interface DnsReport {
  expected: string[];
  hosts: { host: string; ips: string[]; status: 'ok' | 'missing' | 'mismatch' | 'unknown'; apex: boolean }[];
}

export interface WebhookStatus {
  url: string;
  mode?: 'app';
  configured: boolean | null;
  active?: boolean;
  events?: string[];
  lastResponse?: { code: number | null; status: string | null; message: string | null } | null;
  error?: string;
}

export interface EnvVar {
  key: string;
  value: string;
}

export interface LogLine {
  id: number;
  ts: string;
  stream: 'system' | 'stdout' | 'stderr';
  line: string;
}

const TOKEN_KEY = 'catalyst.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  if (token === getToken()) return;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // stockage indisponible : la session ne survivra pas au rechargement
  }
  window.dispatchEvent(new Event('catalyst:auth'));
}

export async function getMe(): Promise<User | null> {
  try {
    return await api<User>('GET', '/auth/me', undefined, getToken(), true);
  } catch (err) {
    if ((err as ApiError).status === 401) return null;
    throw err;
  }
}

export async function logout(): Promise<void> {
  await api('POST', '/auth/logout', {}, getToken(), true).catch(() => {});
  setToken(null);
  window.dispatchEvent(new Event('catalyst:auth'));
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Appel à l'API (/api/...) ; `raw` pour les routes hors /api (ex. /auth/me). */
export async function api<T>(method: string, path: string, body?: unknown, token = getToken(), raw = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${raw ? '' : '/api'}${path}`, {
      credentials: 'same-origin',
      method,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, t("Catalyst isn't responding (server stopped or restarting). Try again in a few seconds."));
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    // Token admin refusé : on l'oublie. (Sans token, un 401 veut juste dire « pas connecté ».)
    if (res.status === 401 && token && token === getToken()) setToken(null);
    const message = (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

/**
 * Suit les logs d'un déploiement en SSE (via fetch : EventSource ne permet pas
 * d'envoyer l'en-tête Authorization). Résout avec le statut final.
 */
export async function streamLogs(
  deploymentId: number,
  after: number,
  onLine: (line: LogLine) => void,
  signal: AbortSignal,
): Promise<DeploymentStatus | null> {
  const token = getToken();
  const res = await fetch(`/api/deployments/${deploymentId}/logs?follow=1&after=${after}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok || !res.body) throw new ApiError(res.status, t('Logs unavailable ({status})', { status: res.status }));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return null;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = /^event: (.*)$/m.exec(raw)?.[1];
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      const id = Number(/^id: (.*)$/m.exec(raw)?.[1] ?? 0);
      if (!data) continue;
      const parsed = JSON.parse(data) as Omit<LogLine, 'id'> & { status?: DeploymentStatus };
      if (event === 'end') return parsed.status ?? null;
      onLine({ id, ts: parsed.ts, stream: parsed.stream, line: parsed.line });
    }
  }
}
