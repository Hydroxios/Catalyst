import type Docker from 'dockerode';
import { wwwRedirectHosts, type ProjectConfig } from '../config/projects.js';

// Conventions de nommage (plan §10).
export const sha12 = (sha: string): string => sha.slice(0, 12);
export const imageTag = (slug: string, sha: string): string => `catalyst/${slug}:${sha12(sha)}`;
/**
 * `<slug>-<sha12>-<id>` : l'id du déploiement évite un conflit de nom quand on
 * redéploie (ou rollback vers) un SHA dont le conteneur tourne encore.
 */
export const containerName = (slug: string, sha: string, deploymentId: number): string =>
  `${slug}-${sha12(sha)}-${deploymentId}`;

const MEMORY_UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** "512m" → octets (même sémantique que `docker run --memory`). */
export function parseMemory(value: string): number {
  const m = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(value.trim());
  if (!m) throw new Error(`invalid memory: ${value}`);
  return Math.floor(Number(m[1]) * MEMORY_UNITS[(m[2] || 'b').toLowerCase()]!);
}

/** "0.5" → NanoCpus (même sémantique que `docker run --cpus`). */
export function parseCpus(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid cpus: ${value}`);
  return Math.round(n * 1e9);
}

/** Fichier `<slug>.env` → ["KEY=VALUE", ...] (commentaires, lignes vides et `export ` ignorés). */
export function parseEnvFile(content: string): string[] {
  const out: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2]!;
      if (quoted[1] === '"') value = value.replace(/\\([n"\\])/g, (_, c: string) => (c === 'n' ? '\n' : c));
    }
    out.push(`${m[1]}=${value}`);
  }
  return out;
}

/** Inverse de parseEnvFile : valeurs entre guillemets doubles, `\`, `"` et retours à la ligne échappés. */
export function serializeEnvFile(vars: { key: string; value: string }[]): string {
  const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
  return vars.map((v) => `${v.key}="${escape(v.value)}"\n`).join('');
}

export interface TraefikOptions {
  network: string;
  entrypoint: string;
  certResolver: string;
}

/**
 * Labels Traefik définitifs (plan §11.2). Router et service portent le nom du
 * projet (pas le SHA) : deux conteneurs avec les mêmes labels = Traefik répartit
 * entre les deux, ce qui permet la bascule sans trou (plan §12).
 */
export function traefikLabels(project: ProjectConfig, opts: TraefikOptions): Record<string, string> {
  const r = project.slug;
  const hostRule = (hosts: string[]) => hosts.map((d) => `Host(\`${d}\`)`).join(' || ');
  const labels: Record<string, string> = {
    'traefik.enable': 'true',
    'traefik.docker.network': opts.network,
    [`traefik.http.routers.${r}.rule`]: hostRule(project.domains),
    [`traefik.http.routers.${r}.entrypoints`]: opts.entrypoint,
    ...(opts.certResolver ? { [`traefik.http.routers.${r}.tls.certresolver`]: opts.certResolver } : {}),
    [`traefik.http.routers.${r}.service`]: r,
    [`traefik.http.services.${r}.loadbalancer.server.port`]: String(project.port),
  };

  // www.<domaine> → <domaine> (301), avec son propre certificat.
  const www = wwwRedirectHosts(project);
  if (www.length > 0) {
    const w = `${r}-www`;
    Object.assign(labels, {
      [`traefik.http.routers.${w}.rule`]: hostRule(www),
      [`traefik.http.routers.${w}.entrypoints`]: opts.entrypoint,
      ...(opts.certResolver ? { [`traefik.http.routers.${w}.tls.certresolver`]: opts.certResolver } : {}),
      [`traefik.http.routers.${w}.service`]: r,
      [`traefik.http.routers.${w}.middlewares`]: w,
      [`traefik.http.middlewares.${w}.redirectregex.regex`]: '^https?://www\\.(.+)',
      [`traefik.http.middlewares.${w}.redirectregex.replacement`]: `${opts.certResolver ? 'https' : 'http'}://\${1}`,
      [`traefik.http.middlewares.${w}.redirectregex.permanent`]: 'true',
    });
  }
  return labels;
}

/**
 * Commande du healthcheck Docker : essaie wget, curl, puis node et python, pour fonctionner
 * dans la plupart des images (alpine, node, python:slim…) sans rien y installer.
 */
export function healthCommand(url: string): string {
  const node = `fetch('${url}').then(r=>process.exit(r.status<400?0:1)).catch(()=>process.exit(1))`;
  const py = `import urllib.request;urllib.request.urlopen('${url}',timeout=2)`;
  return [
    `wget -q -O /dev/null '${url}'`,
    `curl -fsS -o /dev/null '${url}'`,
    `node -e "${node}"`,
    `python3 -c "${py}"`,
  ]
    .map((c) => `${c} 2>/dev/null`)
    .join(' || ')
    .concat(' || exit 1');
}

export interface ContainerSpecInput {
  project: ProjectConfig;
  sha: string;
  deploymentId: number;
  image: string;
  name: string;
  /** true : labels Traefik posés dès la création. */
  routed: boolean;
  /** true : healthcheck Docker (Traefik ne route pas tant que le conteneur n'est pas `healthy`). */
  dockerHealthcheck: boolean;
  healthTimeoutSeconds: number;
  env: string[];
  traefik: TraefikOptions;
}

export function buildContainerSpec(i: ContainerSpecInput): Docker.ContainerCreateOptions {
  const { project } = i;
  const labels: Record<string, string> = {
    'catalyst.project': project.slug,
    'catalyst.sha': i.sha,
    'catalyst.deployment': String(i.deploymentId),
    ...(i.routed ? traefikLabels(project, i.traefik) : { 'traefik.enable': 'false' }),
  };

  const url = `http://127.0.0.1:${project.port}${project.healthcheck.path}`;
  const healthcheck: Docker.HealthConfig | undefined = i.dockerHealthcheck
    ? {
        Test: ['CMD-SHELL', healthCommand(url)],
        Interval: 3e9,
        Timeout: 2e9,
        Retries: 3,
        // Les échecs pendant cette période ne comptent pas ; un succès rend le conteneur `healthy`.
        StartPeriod: i.healthTimeoutSeconds * 1e9,
      }
    : undefined;

  return {
    name: i.name,
    Image: i.image,
    Env: i.env,
    Labels: labels,
    ...(healthcheck ? { Healthcheck: healthcheck } : {}),
    HostConfig: {
      NetworkMode: i.traefik.network,
      Memory: parseMemory(project.resources.memory),
      NanoCpus: parseCpus(project.resources.cpus),
      PidsLimit: 512,
      Privileged: false,
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      // Aucun port publié sur l'hôte : seul Traefik y accède via le réseau partagé.
    },
  };
}

export interface ImageInfo {
  id: string;
  tags: string[];
  created: number;
}

/**
 * Images d'un projet à supprimer (plan §18) : on garde les `keep` plus récentes
 * + toutes celles dont un tag est protégé (image en ligne, build en cours).
 */
export function selectImagesToDelete(images: ImageInfo[], keep: number, protectedTags: Set<string>): ImageInfo[] {
  const sorted = [...images].sort((a, b) => b.created - a.created);
  return sorted.slice(keep).filter((img) => !img.tags.some((t) => protectedTags.has(t)));
}
