import { describe, expect, it } from 'vitest';
import { detect, nodeMajor, renderDockerfile, type FileSource } from '../src/build/detect.js';

/** Repo en mémoire : { "chemin": "contenu" } ; les dossiers sont déduits des chemins. */
function repo(files: Record<string, string>): FileSource {
  return {
    async read(path) {
      return path in files ? files[path]! : null;
    },
    async list(dir) {
      const prefix = dir === '.' ? '' : `${dir.replace(/\/$/, '')}/`;
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const i = rest.indexOf('/');
        names.add(i === -1 ? rest : `${rest.slice(0, i + 1)}`);
      }
      return [...names];
    },
  };
}

const pkg = (o: object) => JSON.stringify(o);

describe('détection Node', () => {
  it('Next.js avec pnpm', async () => {
    const d = await detect(
      repo({
        'package.json': pkg({ scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15', react: '19' } }),
        'pnpm-lock.yaml': '',
      }),
    );
    expect(d).toMatchObject({ stack: 'node', label: 'Next.js (pnpm)', port: 3000, start: 'pnpm run start', build: 'pnpm run build' });
    expect(d.install).toContain('pnpm install --frozen-lockfile');
  });

  it('SPA Vite servie en statique (script start = serveur de dev ignoré)', async () => {
    const d = await detect(
      repo({
        'package.json': pkg({ scripts: { build: 'vite build', start: 'vite' }, devDependencies: { vite: '6' } }),
        'package-lock.json': '{}',
      }),
    );
    expect(d.stack).toBe('node-static');
    expect(d.port).toBe(80);
    expect(d.install).toBe('npm ci');
    expect(d.outputDirs?.[0]).toBe('dist');
  });

  it('Express sans script start : node <main>', async () => {
    const d = await detect(
      repo({ 'package.json': pkg({ main: 'src/server.js', dependencies: { express: '4' } }), 'src/server.js': '' }),
    );
    expect(d).toMatchObject({ stack: 'node', start: 'node src/server.js', install: 'npm install' });
  });

  it('Nuxt sans script start : serveur Nitro', async () => {
    const d = await detect(repo({ 'package.json': pkg({ scripts: { build: 'nuxt build' }, dependencies: { nuxt: '3' } }) }));
    expect(d.start).toBe('node .output/server/index.mjs');
  });

  it('bun', async () => {
    const d = await detect(
      repo({ 'package.json': pkg({ scripts: { start: 'bun src/index.ts' }, dependencies: { hono: '4' } }), 'bun.lock': '' }),
    );
    expect(d).toMatchObject({ stack: 'bun', image: 'oven/bun:1-alpine', start: 'bun run start' });
  });

  it('erreur claire sans commande de démarrage', async () => {
    await expect(detect(repo({ 'package.json': pkg({ dependencies: { express: '4' } }) }))).rejects.toThrow(
      'start command could not be guessed',
    );
  });

  it('les surcharges priment', async () => {
    const d = await detect(repo({ 'package.json': pkg({ dependencies: { express: '4' } }) }), {
      start_command: 'node dist/app.js',
      build_command: 'npm run compile',
    });
    expect(d).toMatchObject({ start: 'node dist/app.js', build: 'npm run compile' });
  });

  it('version de Node depuis engines', () => {
    expect(nodeMajor('^20.11')).toBe(20);
    expect(nodeMajor('>=18')).toBe(22);
    expect(nodeMajor(undefined)).toBe(22);
    expect(nodeMajor('16.x')).toBe(18);
  });
});

describe('détection Python', () => {
  it('FastAPI', async () => {
    const d = await detect(repo({ 'requirements.txt': 'fastapi==0.115\npydantic', 'app/main.py': '' }));
    expect(d).toMatchObject({ stack: 'python', label: 'FastAPI', port: 8000 });
    expect(d.start).toBe('uvicorn app.main:app --host 0.0.0.0 --port $PORT');
    expect(d.pipExtra).toEqual(['uvicorn']);
  });

  it('Django avec gunicorn déjà présent', async () => {
    const d = await detect(
      repo({ 'requirements.txt': 'Django>=5\ngunicorn', 'manage.py': '', 'monsite/wsgi.py': '', 'monsite/settings.py': '' }),
    );
    expect(d.start).toBe('gunicorn monsite.wsgi:application --bind 0.0.0.0:$PORT');
    expect(d.pipExtra).toEqual([]);
  });

  it('Procfile prioritaire, version depuis .python-version', async () => {
    const d = await detect(
      repo({ 'pyproject.toml': '[project]\nname="x"', 'uv.lock': '', Procfile: 'web: python -m app\n', '.python-version': '3.11.9' }),
    );
    expect(d).toMatchObject({ start: 'python -m app', image: 'python:3.11-slim', venv: true });
  });
});

describe('détection Go et statique', () => {
  it('Go avec main à la racine', async () => {
    const d = await detect(repo({ 'go.mod': 'module x\n\ngo 1.22.4\n', 'main.go': 'package main\n' }));
    expect(d).toMatchObject({ stack: 'go', image: 'golang:1.22-alpine', goTarget: '.', port: 8080 });
  });

  it('Go avec une seule commande dans cmd/', async () => {
    const d = await detect(repo({ 'go.mod': 'module x\ngo 1.23', 'cmd/api/main.go': 'package main' }));
    expect(d.goTarget).toBe('./cmd/api');
  });

  it('site statique', async () => {
    expect((await detect(repo({ 'index.html': '<html>' }))).stack).toBe('static');
  });

  it('stack inconnue : message explicite', async () => {
    await expect(detect(repo({ 'Cargo.toml': '' }))).rejects.toThrow('Rust');
    await expect(detect(repo({ 'README.md': '' }))).rejects.toThrow('no supported stack found');
  });
});

describe('Dockerfile généré', () => {
  it('Node : install, build, port configuré, ARG des build args', async () => {
    const d = await detect(
      repo({ 'package.json': pkg({ scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15' } }) }),
    );
    const df = renderDockerfile(d, { port: 4000, buildArgKeys: ['NEXT_PUBLIC_API'] });
    expect(df).toContain('FROM node:22-alpine');
    expect(df).toContain('ARG NEXT_PUBLIC_API');
    expect(df).toContain('RUN npm run build');
    expect(df).toContain('PORT=4000');
    expect(df).toContain('CMD ["sh", "-c", "exec npm run start"]');
    // NODE_ENV=production seulement après l'install, sinon les devDependencies du build manquent.
    expect(df.indexOf('NODE_ENV=production')).toBeGreaterThan(df.indexOf('RUN npm install'));
  });

  it('SPA : multi-étapes vers nginx sur le port du projet', async () => {
    const d = await detect(repo({ 'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '6' } }) }));
    const df = renderDockerfile(d, { port: 8080, buildArgKeys: [] });
    expect(df).toContain('FROM nginx:1.27-alpine');
    expect(df).toContain('listen 8080;');
    expect(df).toContain('/index.html;');
    expect(df).toContain('COPY --from=build /site /usr/share/nginx/html');
  });

  it('Python : dépendances serveur ajoutées', async () => {
    const d = await detect(repo({ 'requirements.txt': 'flask', 'app.py': '' }));
    const df = renderDockerfile(d, { port: 8000, buildArgKeys: [] });
    expect(df).toContain('RUN pip install -r requirements.txt');
    expect(df).toContain('RUN pip install gunicorn');
    expect(df).toContain('exec gunicorn app:app --bind 0.0.0.0:$PORT');
  });

  it('Go : binaire statique dans alpine', async () => {
    const d = await detect(repo({ 'go.mod': 'module x\ngo 1.23', 'main.go': 'package main' }));
    const df = renderDockerfile(d, { port: 8080, buildArgKeys: [] });
    expect(df).toContain('go build -trimpath');
    expect(df).toContain('FROM alpine:3.20');
    expect(df).toContain('CMD ["/server"]');
  });
});

describe('branches', () => {
  it('les plus récemment poussées d’abord, puis celles sans date', async () => {
    const { sortByActivity } = await import('../src/github/branches.js');
    const b = (name: string, date: string | null, isDefault = false) => ({ name, sha: '', date, message: null, author: null, isDefault });
    const sorted = sortByActivity([
      b('main', '2026-01-22T09:57:36Z', true),
      b('old', null),
      b('dev', '2026-10-04T23:04:06Z'),
      b('feature', '2026-03-01T00:00:00Z'),
    ]);
    expect(sorted.map((x) => x.name)).toEqual(['dev', 'feature', 'main', 'old']);
  });
});

describe('ports imposés et config nginx', () => {
  it('repère un port écrit en dur dans la commande de démarrage', async () => {
    const { forcedPortIn } = await import('../src/build/detect.js');
    expect(forcedPortIn('next start -p 8001')).toBe(8001);
    expect(forcedPortIn('vite preview --port=4173')).toBe(4173);
    expect(forcedPortIn('gunicorn app:app --bind 0.0.0.0:8000')).toBe(8000);
    expect(forcedPortIn('next start -p $PORT')).toBeUndefined();
    expect(forcedPortIn('node server.js')).toBeUndefined();
  });

  it('le port imposé devient le port proposé, avec la raison', async () => {
    const d = await detect(
      repo({ 'package.json': pkg({ scripts: { build: 'next build', start: 'next start -p 8001' }, dependencies: { next: '16' } }) }),
    );
    expect(d.port).toBe(8001);
    expect(d.forcedPort).toBe(8001);
  });

  it('la config nginx garde $uri (entre apostrophes, pas d’expansion par le shell)', async () => {
    const d = await detect(repo({ 'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '6' } }) }));
    const df = renderDockerfile(d, { port: 3010, buildArgKeys: [] });
    const run = df.split('\n').find((l) => l.includes('/etc/nginx/conf.d/default.conf'))!;
    expect(run).toContain("printf '%s\\n' 'server {");
    expect(run).toContain('try_files $uri $uri/ $uri.html /index.html;');
    // Aucune apostrophe dans la conf, sinon la chaîne shell serait cassée.
    expect(run.slice(run.indexOf("'server"), run.lastIndexOf("'")).slice(1).includes("'")).toBe(false);
  });
});
