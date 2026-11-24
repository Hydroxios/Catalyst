import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isAdminToken as isAuthorized } from '../src/auth/session.js';
import { parseProjects } from '../src/config/projects.js';
import { demuxDockerLogs } from '../src/docker/client.js';
import {
  buildContainerSpec,
  containerName,
  imageTag,
  parseCpus,
  parseEnvFile,
  parseMemory,
  selectImagesToDelete,
  serializeEnvFile,
  traefikLabels,
} from '../src/docker/spec.js';
import { verifySignature } from '../src/github/signature.js';
import { decidePush } from '../src/receiver/webhook.js';
import { maskSecrets } from '../src/worker/logger.js';

const SECRET = 'un-secret-de-test-assez-long';
const sign = (body: Buffer, secret = SECRET) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('verifySignature', () => {
  const body = Buffer.from('{"hello":"world"}');

  it('accepte une signature valide', () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });
  it('refuse une signature calculée avec un autre secret', () => {
    expect(verifySignature(body, sign(body, 'autre-secret-xxxxxxxx'), SECRET)).toBe(false);
  });
  it('refuse un corps modifié', () => {
    expect(verifySignature(Buffer.from('{"hello":"World"}'), sign(body), SECRET)).toBe(false);
  });
  it('refuse un header absent ou sans préfixe', () => {
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, sign(body).slice(7), SECRET)).toBe(false);
  });
  it('refuse une signature de longueur différente sans lever', () => {
    expect(verifySignature(body, 'sha256=abc', SECRET)).toBe(false);
  });
});

describe('parseProjects', () => {
  const base = { slug: 'mon-site', repo: 'killian/mon-site', port: 3000 };

  it('applique les valeurs par défaut', () => {
    const [p] = parseProjects({ projects: [base] }, 'mondomaine.fr');
    expect(p).toMatchObject({
      branch: 'main',
      dockerfile: 'Dockerfile',
      context: '.',
      domains: ['mon-site.mondomaine.fr'],
      healthcheck: { path: '/', mode: 'docker' },
      resources: { memory: '512m', cpus: '0.5' },
      build_args: {},
      deploy_on_first_seen: true,
    });
  });

  it('convertit build_args et cpus en chaînes', () => {
    const [p] = parseProjects(
      { projects: [{ ...base, build_args: { N: 1, B: true }, resources: { cpus: 1 } }] },
      'x.fr',
    );
    expect(p!.build_args).toEqual({ N: '1', B: 'true' });
    expect(p!.resources.cpus).toBe('1');
  });

  it.each([
    [{ ...base, slug: 'Mon_Site' }, 'slug'],
    [{ ...base, repo: 'pas-de-slash' }, 'repo'],
    [{ ...base, port: 70000 }, 'port'],
    [{ ...base, dockerfile: '../Dockerfile' }, 'dockerfile'],
    [{ ...base, context: '/etc' }, 'context'],
    [{ ...base, inconnu: 1 }, 'inconnu'],
  ])('refuse une config invalide (%#)', (project, field) => {
    expect(() => parseProjects({ projects: [project] }, 'x.fr')).toThrow(field);
  });

  it('refuse les doublons de slug, repo/branche et domaine', () => {
    expect(() => parseProjects({ projects: [base, { ...base, repo: 'a/b' }] }, 'x.fr')).toThrow('slug mon-site is duplicated');
    expect(() => parseProjects({ projects: [base, { ...base, slug: 'autre' }] }, 'x.fr')).toThrow('killian/mon-site (main) is duplicated');
    expect(() =>
      parseProjects(
        { projects: [base, { slug: 'autre', repo: 'a/b', port: 1, domains: ['mon-site.x.fr'] }] },
        'x.fr',
      ),
    ).toThrow('domain');
  });

  it('accepte un domaine racine', () => {
    const [p] = parseProjects({ projects: [{ ...base, domains: ['MonDomaine.fr'] }] }, 'x.fr');
    expect(p!.domains).toEqual(['mondomaine.fr']);
  });

  it('détecte un conflit avec une redirection www', () => {
    const apex = { ...base, domains: ['a.fr'], www_redirect: true };
    const other = { slug: 'autre', repo: 'a/b', port: 1, domains: ['www.a.fr'] };
    expect(() => parseProjects({ projects: [apex, other] }, 'x.fr')).toThrow('www.a.fr');
  });

  it('accepte un fichier sans projets', () => {
    expect(parseProjects({ projects: [] }, 'x.fr')).toEqual([]);
    expect(parseProjects(null, 'x.fr')).toEqual([]);
  });

  it('accepte le même repo sur deux branches', () => {
    const list = parseProjects({ projects: [base, { ...base, slug: 'mon-site-dev', branch: 'dev' }] }, 'x.fr');
    expect(list).toHaveLength(2);
  });
});

describe('decidePush', () => {
  const sha = 'a'.repeat(40);
  it('déploie un push sur la branche suivie', () => {
    expect(decidePush({ ref: 'refs/heads/main', after: sha }, 'main')).toEqual({ deploy: true, sha });
  });
  it('ignore une autre branche', () => {
    expect(decidePush({ ref: 'refs/heads/dev', after: sha }, 'main').deploy).toBe(false);
  });
  it('ignore un tag', () => {
    expect(decidePush({ ref: 'refs/tags/main', after: sha }, 'main').deploy).toBe(false);
  });
  it('ignore une branche supprimée', () => {
    expect(decidePush({ ref: 'refs/heads/main', after: '0'.repeat(40), deleted: true }, 'main').deploy).toBe(false);
  });
});

describe('docker spec', () => {
  const [project] = parseProjects(
    { projects: [{ slug: 'mon-site', repo: 'k/mon-site', port: 3000, domains: ['a.fr', 'www.a.fr'] }] },
    'x.fr',
  );
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const traefik = { network: 'catalyst-net', entrypoint: 'websecure', certResolver: 'le' };

  it('nomme images et conteneurs', () => {
    expect(imageTag('mon-site', sha)).toBe('catalyst/mon-site:0123456789ab');
    expect(containerName('mon-site', sha, 42)).toBe('mon-site-0123456789ab-42');
  });

  it('convertit mémoire et CPU', () => {
    expect(parseMemory('512m')).toBe(512 * 1024 * 1024);
    expect(parseMemory('1g')).toBe(1024 ** 3);
    expect(parseCpus('0.5')).toBe(500_000_000);
    expect(() => parseMemory('beaucoup')).toThrow();
  });

  it('génère les labels Traefik avec router/service = slug', () => {
    const labels = traefikLabels(project!, traefik);
    expect(labels['traefik.http.routers.mon-site.rule']).toBe('Host(`a.fr`) || Host(`www.a.fr`)');
    expect(labels['traefik.http.services.mon-site.loadbalancer.server.port']).toBe('3000');
    expect(labels['traefik.http.routers.mon-site.tls.certresolver']).toBe('le');
  });

  it('redirige www vers le domaine racine', () => {
    const apex = { ...project!, slug: 'site', domains: ['mondomaine.fr'], www_redirect: true };
    const labels = traefikLabels(apex, traefik);
    expect(labels['traefik.http.routers.site.rule']).toBe('Host(`mondomaine.fr`)');
    expect(labels['traefik.http.routers.site-www.rule']).toBe('Host(`www.mondomaine.fr`)');
    expect(labels['traefik.http.routers.site-www.middlewares']).toBe('site-www');
    expect(labels['traefik.http.middlewares.site-www.redirectregex.permanent']).toBe('true');
    const re = new RegExp(labels['traefik.http.middlewares.site-www.redirectregex.regex']!);
    expect('https://www.mondomaine.fr/a?b=1'.replace(re, 'https://$1')).toBe('https://mondomaine.fr/a?b=1');
  });

  it('mode local : routage HTTP sans certificat', () => {
    const local = { ...traefik, entrypoint: 'web', certResolver: '' };
    const apex = { ...project!, slug: 'site', domains: ['site.localhost'], www_redirect: true };
    const labels = traefikLabels(apex, local);
    expect(Object.keys(labels).some((k) => k.includes('tls'))).toBe(false);
    expect(labels['traefik.http.routers.site.entrypoints']).toBe('web');
    expect(labels['traefik.http.middlewares.site-www.redirectregex.replacement']).toBe('http://${1}');
  });

  it('pas de redirection www sans www_redirect', () => {
    expect(Object.keys(traefikLabels(project!, traefik)).some((k) => k.includes('-www'))).toBe(false);
  });

  it('construit un conteneur limité, sans port publié', () => {
    const spec = buildContainerSpec({
      project: project!,
      sha,
      deploymentId: 1,
      image: 'catalyst/mon-site:0123456789ab',
      name: 'mon-site-0123456789ab-1',
      routed: true,
      dockerHealthcheck: true,
      healthTimeoutSeconds: 60,
      env: ['A=1'],
      traefik,
    });
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: 'catalyst-net',
      Memory: 512 * 1024 * 1024,
      NanoCpus: 500_000_000,
      PidsLimit: 512,
      Privileged: false,
      RestartPolicy: { Name: 'unless-stopped' },
    });
    expect(spec.HostConfig?.PortBindings).toBeUndefined();
    expect(spec.Healthcheck?.Test?.[1]).toContain('http://127.0.0.1:3000/');
    expect(spec.Labels?.['traefik.enable']).toBe('true');
  });

  it('un candidat non routé a traefik.enable=false', () => {
    const spec = buildContainerSpec({
      project: project!,
      sha,
      deploymentId: 1,
      image: 'i',
      name: 'n',
      routed: false,
      dockerHealthcheck: false,
      healthTimeoutSeconds: 60,
      env: [],
      traefik,
    });
    expect(spec.Labels?.['traefik.enable']).toBe('false');
    expect(spec.Healthcheck).toBeUndefined();
  });
});

describe('selectImagesToDelete', () => {
  const img = (n: number) => ({ id: `id${n}`, tags: [`catalyst/p:${n}`], created: n });

  it('garde les N plus récentes', () => {
    const del = selectImagesToDelete([img(1), img(5), img(3), img(4), img(2)], 3, new Set());
    expect(del.map((i) => i.id).sort()).toEqual(['id1', 'id2']);
  });
  it("ne supprime jamais l'image en ligne", () => {
    const del = selectImagesToDelete([img(1), img(2), img(3), img(4)], 2, new Set(['catalyst/p:1']));
    expect(del.map((i) => i.id)).toEqual(['id2']);
  });
  it('rien à supprimer sous le seuil', () => {
    expect(selectImagesToDelete([img(1)], 3, new Set())).toEqual([]);
  });
});

describe('parseEnvFile', () => {
  it('lit un fichier .env', () => {
    const content = '# commentaire\n\nA=1\nexport B="deux mots"\nC=\'x=y\'\nD="l1\\nl2"\nmauvaise ligne\n';
    expect(parseEnvFile(content)).toEqual(['A=1', 'B=deux mots', 'C=x=y', 'D=l1\nl2']);
  });
});

describe('serializeEnvFile', () => {
  it('fait l’aller-retour avec parseEnvFile', () => {
    const vars = [
      { key: 'A', value: 'simple' },
      { key: 'B', value: 'avec "guillemets" et \\ antislash \\n littéral' },
      { key: 'C', value: 'ligne1\nligne2' },
      { key: 'D', value: '' },
    ];
    const parsed = parseEnvFile(serializeEnvFile(vars));
    expect(parsed).toEqual(vars.map((v) => `${v.key}=${v.value}`));
  });
});

describe('demuxDockerLogs', () => {
  const frame = (type: number, text: string) => {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };
  it('sépare stdout et stderr', () => {
    const buf = Buffer.concat([frame(1, 'hello\nworld\n'), frame(2, 'boom\n')]);
    expect(demuxDockerLogs(buf)).toEqual([
      { stream: 'stdout', line: 'hello' },
      { stream: 'stdout', line: 'world' },
      { stream: 'stderr', line: 'boom' },
    ]);
  });
});

describe('secrets', () => {
  it('masque les tokens dans les logs', () => {
    expect(maskSecrets('https://x-access-token:ghp_abc@github.com/a/b', [])).toBe(
      'https://x-access-token:***@github.com/a/b',
    );
    expect(maskSecrets('token=supersecret123 ok', ['supersecret123'])).toBe('token=*** ok');
  });
  it('vérifie le token admin', () => {
    expect(isAuthorized('Bearer le-bon-token-admin', 'le-bon-token-admin')).toBe(true);
    expect(isAuthorized('Bearer mauvais', 'le-bon-token-admin')).toBe(false);
    expect(isAuthorized(undefined, 'le-bon-token-admin')).toBe(false);
  });
});

describe('messages et journaux', () => {
  it('traduit les erreurs réseau du healthcheck', async () => {
    const { describeFetchError } = await import('../src/worker/steps/healthcheck.js');
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(describeFetchError(refused, 3002)).toContain('connection refused on port 3002');
    expect(describeFetchError(Object.assign(new Error('x'), { name: 'TimeoutError' }), 80)).toContain('no response');
  });

  it('reconnaît les lignes de journal par requête d’Octokit', async () => {
    const { isRequestLogLine } = await import('../src/github/service.js');
    expect(isRequestLogLine(['GET /repos/a/b/commits/dev - 304 with id C5C4 in 291ms'])).toBe(true);
    expect(isRequestLogLine(['quota API GitHub épuisé'])).toBe(false);
  });
});
