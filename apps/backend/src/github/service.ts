import { createSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Octokit } from '@octokit/rest';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { splitRepo } from './client.js';

/** Identifiants de la GitHub App, créés depuis l'interface (flux « manifest ») et stockés sur le serveur. */
export interface AppCredentials {
  id: number;
  slug: string;
  name: string;
  htmlUrl: string;
  owner: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
  /** Comptes GitHub autorisés à se connecter (en plus de CATALYST_ADMINS). */
  admins: string[];
}

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  pushedAt: string | null;
  description: string | null;
}

export interface GithubUser {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string;
}

export class RepoAccessError extends Error {}

const USER_AGENT = 'catalyst';

/**
 * Octokit journalise chaque réponse en erreur, y compris les 404 attendues (la détection de stack
 * teste l'existence de nombreux fichiers) : on ne garde que les vrais avertissements.
 */
/** Ligne de journal par requête d'Octokit (« GET /repos/… - 304 with id … in 291ms ») : les erreurs sont déjà gérées par l'appelant. */
export const isRequestLogLine = (args: unknown[]) =>
  typeof args[0] === 'string' && /^(GET|POST|PUT|PATCH|DELETE|HEAD) \S+ - \d{3} /.test(args[0]);

const QUIET_LOG = {
  debug: () => {},
  info: () => {},
  warn: (...args: unknown[]) => {
    if (!isRequestLogLine(args)) console.warn(...args);
  },
  error: (...args: unknown[]) => {
    if (!isRequestLogLine(args)) console.error(...args);
  },
};
const octokit = (auth?: string) => new Octokit({ ...(auth ? { auth } : {}), userAgent: USER_AGENT, log: QUIET_LOG });
const INSTALLATION_CACHE_MS = 5 * 60_000;

/**
 * Accès à GitHub pour toute la plateforme.
 *   - GitHub App configurée : tokens d'installation de courte durée, un seul webhook pour tous les repos.
 *   - Sinon : token personnel GITHUB_TOKEN (mode historique).
 */
export class GitHubService {
  private creds: AppCredentials | null = null;
  private readonly pat: Octokit | null;
  private readonly installationByRepo = new Map<string, { id: number | null; at: number }>();
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {
    this.pat = env.GITHUB_TOKEN ? octokit(env.GITHUB_TOKEN) : null;
    const file = this.appFile();
    if (existsSync(file)) {
      try {
        this.creds = JSON.parse(readFileSync(file, 'utf8')) as AppCredentials;
      } catch (err) {
        log.error({ err, file }, 'unreadable GitHub App file');
      }
    }
  }

  // --- Configuration ---

  private appFile(): string {
    return join(this.env.DATA_DIR, 'github-app.json');
  }

  get app(): AppCredentials | null {
    return this.creds;
  }

  get mode(): 'app' | 'token' | 'none' {
    return this.creds ? 'app' : this.pat ? 'token' : 'none';
  }

  installUrl(): string | null {
    return this.creds ? `${this.creds.htmlUrl}/installations/new` : null;
  }

  saveApp(creds: AppCredentials): void {
    const file = this.appFile();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(creds, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    this.creds = creds;
    this.installationByRepo.clear();
    this.tokens.clear();
  }

  /** Secrets acceptés pour signer les webhooks : celui de l'App et/ou GITHUB_WEBHOOK_SECRET. */
  webhookSecrets(): string[] {
    return [this.creds?.webhookSecret, this.env.GITHUB_WEBHOOK_SECRET].filter((s): s is string => !!s);
  }

  admins(): string[] {
    const fromEnv = (this.env.CATALYST_ADMINS ?? '').split(/[\s,]+/).filter(Boolean);
    return [...new Set([...fromEnv, ...(this.creds?.admins ?? [])].map((a) => a.toLowerCase()))];
  }

  isAdmin(login: string): boolean {
    return this.admins().includes(login.toLowerCase());
  }

  setAdmins(admins: string[]): void {
    if (!this.creds) throw new Error('GitHub App is not configured');
    this.saveApp({ ...this.creds, admins: [...new Set(admins.map((a) => a.trim()).filter(Boolean))] });
  }

  // --- Authentification de l'App ---

  /** JWT RS256 signé avec la clé privée de l'App (valable 9 min). */
  private appJwt(): string {
    if (!this.creds) throw new RepoAccessError('GitHub App is not configured');
    const now = Math.floor(Date.now() / 1000);
    const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: String(this.creds.id) })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.creds.privateKey).toString('base64url');
    return `${unsigned}.${signature}`;
  }

  private appOctokit(): Octokit {
    return octokit(this.appJwt());
  }

  private async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const { data } = await this.appOctokit().rest.apps.createInstallationAccessToken({ installation_id: installationId });
    this.tokens.set(installationId, { token: data.token, expiresAt: new Date(data.expires_at).getTime() });
    return data.token;
  }

  private async installationFor(repo: string): Promise<number | null> {
    const key = repo.toLowerCase();
    const cached = this.installationByRepo.get(key);
    if (cached && Date.now() - cached.at < INSTALLATION_CACHE_MS) return cached.id;
    const { owner, name } = splitRepo(repo);
    let id: number | null = null;
    try {
      const { data } = await this.appOctokit().rest.apps.getRepoInstallation({ owner, repo: name });
      id = data.id;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
    }
    this.installationByRepo.set(key, { id, at: Date.now() });
    return id;
  }

  /**
   * Client GitHub + token git pour un repo. Préfère la GitHub App si elle est installée sur ce repo,
   * sinon le token personnel.
   */
  async forRepo(repo: string): Promise<{ octokit: Octokit; token: string }> {
    if (this.creds) {
      const installation = await this.installationFor(repo);
      if (installation !== null) {
        const token = await this.installationToken(installation);
        return { octokit: octokit(token), token };
      }
    }
    if (this.pat && this.env.GITHUB_TOKEN) return { octokit: this.pat, token: this.env.GITHUB_TOKEN };
    throw new RepoAccessError(
      this.creds
        ? `the GitHub App ${this.creds.slug} has no access to ${repo}: add this repo to its installation`
        : `no GitHub access configured for ${repo} (GitHub App or GITHUB_TOKEN)`,
    );
  }

  /** Repos importables : ceux des installations de l'App, sinon ceux visibles par le token. */
  async listRepos(): Promise<RepoInfo[]> {
    const map = (r: {
      full_name: string;
      default_branch?: string;
      private: boolean;
      pushed_at?: string | null;
      description?: string | null;
    }): RepoInfo => ({
      fullName: r.full_name,
      defaultBranch: r.default_branch ?? 'main',
      private: r.private,
      pushedAt: r.pushed_at ?? null,
      description: r.description ?? null,
    });

    const repos: RepoInfo[] = [];
    if (this.creds) {
      const app = this.appOctokit();
      const installations = await app.paginate(app.rest.apps.listInstallations, { per_page: 100 });
      for (const inst of installations) {
        const token = await this.installationToken(inst.id);
        const gh = octokit(token);
        const list = await gh.paginate(gh.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
        for (const r of list) {
          repos.push(map(r));
          this.installationByRepo.set(r.full_name.toLowerCase(), { id: inst.id, at: Date.now() });
        }
      }
    } else if (this.pat) {
      const list = await this.pat.paginate(this.pat.rest.repos.listForAuthenticatedUser, { per_page: 100, sort: 'pushed' });
      repos.push(...list.slice(0, 500).map(map));
    }
    return repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
  }

  // --- Connexion des utilisateurs (OAuth de la GitHub App) ---

  authorizeUrl(state: string, redirectUri: string): string {
    if (!this.creds) throw new Error('GitHub App is not configured');
    const params = new URLSearchParams({ client_id: this.creds.clientId, redirect_uri: redirectUri, state });
    return `https://github.com/login/oauth/authorize?${params}`;
  }

  /** Échange le code OAuth et renvoie l'utilisateur GitHub (le token utilisateur n'est pas conservé). */
  async exchangeCode(code: string, redirectUri: string): Promise<GithubUser> {
    if (!this.creds) throw new Error('GitHub App is not configured');
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { access_token?: string; error_description?: string };
    if (!data.access_token) throw new Error(`OAuth exchange refused: ${data.error_description ?? res.status}`);
    const user = octokit(data.access_token);
    const { data: me } = await user.rest.users.getAuthenticated();
    return { login: me.login, id: me.id, name: me.name ?? null, avatarUrl: me.avatar_url };
  }

  /** Flux « manifest » : GitHub renvoie un code qu'on échange contre les identifiants de l'App créée. */
  async convertManifest(code: string): Promise<AppCredentials> {
    const gh = octokit();
    const { data } = await gh.rest.apps.createFromManifest({ code });
    const owner = (data.owner as { login?: string; type?: string } | null) ?? null;
    return {
      id: data.id,
      slug: data.slug ?? String(data.id),
      name: data.name,
      htmlUrl: data.html_url,
      owner: owner?.login ?? '',
      clientId: data.client_id,
      clientSecret: data.client_secret,
      privateKey: data.pem,
      webhookSecret: data.webhook_secret ?? '',
      // Le compte qui crée l'App devient admin (si c'est une organisation : CATALYST_ADMINS ou réglages).
      admins: owner?.type === 'User' && owner.login ? [owner.login] : [],
    };
  }
}
