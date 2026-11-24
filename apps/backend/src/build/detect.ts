/**
 * Détection automatique de la stack d'un repo sans Dockerfile, et génération d'un Dockerfile adapté.
 * La même détection sert au moment du build (fichiers clonés) et à l'import (API GitHub) : elle ne lit
 * les fichiers qu'à travers `FileSource`.
 */

export interface FileSource {
  /** Contenu d'un fichier (chemin relatif au dossier du projet), ou null s'il n'existe pas. */
  read(path: string): Promise<string | null>;
  /** Entrées d'un dossier (noms seuls ; les dossiers se terminent par "/"), [] s'il n'existe pas. */
  list(dir: string): Promise<string[]>;
}

export type Stack = 'node' | 'node-static' | 'bun' | 'bun-static' | 'python' | 'go' | 'static';

export interface Detection {
  stack: Stack;
  /** Libellé lisible : « Next.js (pnpm) », « FastAPI », « Site statique »… */
  label: string;
  /** Port par défaut de cette stack. */
  port: number;
  install?: string;
  build?: string;
  start?: string;
  /** Image de base (node:22-alpine, python:3.12-slim…). */
  image: string;
  /** Dossiers candidats contenant le site compilé (stacks statiques). */
  outputDirs?: string[];
  /** Cible `go build`. */
  goTarget?: string;
  /** Python : dépendances serveur à ajouter si absentes (gunicorn, uvicorn). */
  pipExtra?: string[];
  /** Python : venv créé par uv à mettre dans le PATH. */
  venv?: boolean;
  /** Avertissements à afficher dans les logs de build. */
  notes: string[];
  /** Port imposé par la commande de démarrage (ex. `next start -p 8001`), qui ignore alors $PORT. */
  forcedPort?: number;
}

/** Port écrit en dur dans une commande (`-p 8001`, `--port=8001`, `--bind 0.0.0.0:8001`), sauf si elle utilise $PORT. */
export function forcedPortIn(cmd: string | undefined): number | undefined {
  if (!cmd || /\$\{?PORT\b/.test(cmd)) return undefined;
  const m =
    /(?:^|\s)(?:-p|--port)(?:\s+|=)(\d{2,5})\b/.exec(cmd) ?? /(?:^|\s)(?:-b|--bind)(?:\s+|=)[\w.[\]:]*:(\d{2,5})\b/.exec(cmd);
  const port = m ? Number(m[1]) : NaN;
  return port >= 1 && port <= 65535 ? port : undefined;
}

export class DetectError extends Error {}

export interface Overrides {
  build_command?: string;
  start_command?: string;
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  main?: string;
  packageManager?: string;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const NODE_MAJORS = [18, 20, 22, 24];

/** "^20.11", ">=18", "20.x" → 20 ; absent ou illisible → 22 (LTS). */
export function nodeMajor(range: string | undefined): number {
  const n = Number(/(\d{2})/.exec(range ?? '')?.[1]);
  if (!n) return 22;
  if (/>=?/.test(range ?? '')) return Math.max(n, 22);
  return NODE_MAJORS.includes(n) ? n : n < 18 ? 18 : 22;
}

type Pm = 'npm' | 'pnpm' | 'yarn' | 'bun';

const run = (pm: Pm, script: string) => (pm === 'npm' ? `npm run ${script}` : pm === 'yarn' ? `yarn ${script}` : `${pm} run ${script}`);

/** Serveurs de développement : un script `start` qui les lance ne sert pas en production. */
const DEV_SERVER = /^\s*(vite|vite preview|react-scripts start|astro (dev|preview)|ng serve|vue-cli-service serve|parcel)\b/;

/** Frameworks qui produisent un serveur Node (et non un site statique). */
const SERVER_DEPS = [
  'next',
  'nuxt',
  '@remix-run/serve',
  '@remix-run/node',
  '@react-router/serve',
  '@sveltejs/adapter-node',
  '@astrojs/node',
  'express',
  'fastify',
  'koa',
  'hono',
  '@hono/node-server',
  '@nestjs/core',
  '@hapi/hapi',
  'socket.io',
];

async function detectNode(src: FileSource, pkg: PackageJson, o: Overrides): Promise<Detection> {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (d: string) => d in deps;
  const scripts = pkg.scripts ?? {};
  const notes: string[] = [];

  const [pnpmLock, yarnLock, bunLockb, bunLock, npmLock, yarnrc] = await Promise.all([
    src.read('pnpm-lock.yaml'),
    src.read('yarn.lock'),
    src.read('bun.lockb'),
    src.read('bun.lock'),
    src.read('package-lock.json'),
    src.read('.yarnrc.yml'),
  ]);
  const declared = pkg.packageManager?.split('@')[0];
  const pm: Pm =
    bunLockb !== null || bunLock !== null || declared === 'bun'
      ? 'bun'
      : pnpmLock !== null || declared === 'pnpm'
        ? 'pnpm'
        : yarnLock !== null || declared === 'yarn'
          ? 'yarn'
          : 'npm';

  const install =
    pm === 'bun'
      ? 'bun install'
      : pm === 'pnpm'
        ? 'corepack enable && pnpm install --frozen-lockfile'
        : pm === 'yarn'
          ? yarnrc !== null
            ? 'corepack enable && yarn install --immutable'
            : 'yarn install --frozen-lockfile'
          : npmLock !== null
            ? 'npm ci'
            : 'npm install';

  const framework = has('next')
    ? 'Next.js'
    : has('nuxt')
      ? 'Nuxt'
      : has('@remix-run/node') || has('@remix-run/serve')
        ? 'Remix'
        : has('@react-router/serve')
          ? 'React Router'
          : has('@sveltejs/kit')
            ? 'SvelteKit'
            : has('astro')
              ? 'Astro'
              : has('@nestjs/core')
                ? 'NestJS'
                : has('@angular/core')
                  ? 'Angular'
                  : has('vite')
                    ? 'Vite'
                    : has('react-scripts')
                      ? 'Create React App'
                      : has('express')
                        ? 'Express'
                        : has('fastify')
                          ? 'Fastify'
                          : 'Node.js';

  const build = o.build_command ?? (scripts.build ? run(pm, 'build') : undefined);
  const isServer = SERVER_DEPS.some(has) && !(has('@sveltejs/kit') && !has('@sveltejs/adapter-node'));
  const prodStart = scripts.start && !DEV_SERVER.test(scripts.start) ? run(pm, 'start') : undefined;

  // Site statique : framework front sans serveur, avec un build.
  if (!o.start_command && !prodStart && !isServer && build) {
    const preferred =
      framework === 'Create React App' ? ['build'] : framework === 'SvelteKit' ? ['build'] : ['dist'];
    return {
      stack: pm === 'bun' ? 'bun-static' : 'node-static',
      label: `${framework} (static, ${pm})`,
      port: 80,
      install,
      build,
      image: pm === 'bun' ? 'oven/bun:1-alpine' : `node:${nodeMajor(pkg.engines?.node)}-alpine`,
      outputDirs: [...new Set([...preferred, 'dist', 'build', 'out', 'public'])],
      notes,
    };
  }

  // Commande de démarrage d'un serveur.
  let start = o.start_command ?? prodStart;
  if (!start) {
    if (framework === 'Next.js') start = pm === 'bun' ? 'bun x next start' : 'npx next start';
    else if (framework === 'Nuxt') start = 'node .output/server/index.mjs';
    else if (framework === 'SvelteKit') start = 'node build';
    else if (framework === 'Astro') start = 'node ./dist/server/entry.mjs';
    else if (framework === 'NestJS') start = 'node dist/main.js';
    else {
      const candidates = [pkg.main, 'server.js', 'index.js', 'app.js', 'src/index.js', 'src/server.js'].filter(
        (f): f is string => !!f,
      );
      for (const file of candidates) {
        if ((await src.read(file)) !== null) {
          start = `${pm === 'bun' ? 'bun' : 'node'} ${file}`;
          break;
        }
      }
    }
  }
  if (!start) {
    throw new DetectError(
      `${framework} detected, but the start command could not be guessed: add a "start" script to package.json, ` +
        'set "Start command" in the project settings, or add a Dockerfile',
    );
  }
  if (scripts.start && DEV_SERVER.test(scripts.start) && !o.start_command) {
    notes.push(`the "start" script runs a development server (${scripts.start}): ignored`);
  }
  // Le texte réellement exécuté : la surcharge, sinon le script "start" du package.json.
  const forcedPort = forcedPortIn(o.start_command ?? (prodStart ? scripts.start : start));

  return {
    stack: pm === 'bun' ? 'bun' : 'node',
    label: `${framework} (${pm})`,
    port: forcedPort ?? 3000,
    ...(forcedPort ? { forcedPort } : {}),
    install,
    build,
    start,
    image: pm === 'bun' ? 'oven/bun:1-alpine' : `node:${nodeMajor(pkg.engines?.node)}-alpine`,
    notes,
  };
}

/** Python : version depuis .python-version / runtime.txt, sinon 3.12. */
function pythonVersion(text: string | null): string {
  const m = /(\d)\.(\d{1,2})/.exec(text ?? '');
  return m ? `${m[1]}.${m[2]}` : '3.12';
}

async function detectPython(src: FileSource, o: Overrides): Promise<Detection | null> {
  const [req, pyproject, pipfile, uvLock, poetryLock, procfile, pyVersion, runtime] = await Promise.all([
    src.read('requirements.txt'),
    src.read('pyproject.toml'),
    src.read('Pipfile'),
    src.read('uv.lock'),
    src.read('poetry.lock'),
    src.read('Procfile'),
    src.read('.python-version'),
    src.read('runtime.txt'),
  ]);
  if (req === null && pyproject === null && pipfile === null) return null;

  const depsText = `${req ?? ''}\n${pyproject ?? ''}\n${pipfile ?? ''}`.toLowerCase();
  const dep = (name: string) => new RegExp(`(^|[\\s"'\\[,])${name}([\\s<>=~!\\[;,"']|$)`, 'm').test(depsText);

  let install: string;
  let venv = false;
  if (uvLock !== null) {
    install = 'pip install uv && uv sync --frozen --no-dev';
    venv = true;
  } else if (poetryLock !== null) {
    install = 'pip install poetry && poetry config virtualenvs.create false && poetry install --only main --no-root';
  } else if (req !== null) {
    install = 'pip install -r requirements.txt';
  } else if (pipfile !== null) {
    install = 'pip install pipenv && pipenv install --system --deploy';
  } else {
    install = 'pip install .';
  }

  const notes: string[] = [];
  const pipExtra: string[] = [];
  const exists = async (f: string) => (await src.read(f)) !== null;
  /** Premier module Python existant parmi les candidats (chemin → module importable). */
  const firstModule = async (files: string[]) => {
    for (const f of files) if (await exists(f)) return f.replace(/\.py$/, '').replace(/\//g, '.');
    return null;
  };

  let label = 'Python';
  let start = o.start_command;
  if (!start) {
    const web = procfile && /^web:\s*(.+)$/m.exec(procfile)?.[1]?.trim();
    if (web) {
      start = web;
      label = 'Python (Procfile)';
    } else if (dep('django') && (await exists('manage.py'))) {
      label = 'Django';
      const dirs = (await src.list('.')).filter((e) => e.endsWith('/')).map((e) => e.slice(0, -1));
      let wsgi: string | null = null;
      for (const d of dirs) if (await exists(`${d}/wsgi.py`)) wsgi = `${d}.wsgi`;
      if (!wsgi) throw new DetectError('Django detected, but no <project>/wsgi.py found at the root');
      start = `gunicorn ${wsgi}:application --bind 0.0.0.0:$PORT`;
      if (!dep('gunicorn')) pipExtra.push('gunicorn');
    } else if (dep('fastapi')) {
      label = 'FastAPI';
      const mod = await firstModule(['main.py', 'app.py', 'app/main.py', 'src/main.py', 'api/main.py']);
      if (!mod) throw new DetectError('FastAPI detected, but no main.py / app.py / app/main.py found');
      start = `uvicorn ${mod}:app --host 0.0.0.0 --port $PORT`;
      if (!dep('uvicorn')) pipExtra.push('uvicorn');
    } else if (dep('flask')) {
      label = 'Flask';
      const mod = await firstModule(['app.py', 'main.py', 'wsgi.py', 'app/__init__.py']);
      if (!mod) throw new DetectError('Flask detected, but no app.py / main.py / wsgi.py found');
      start = `gunicorn ${mod.replace(/\.__init__$/, '')}:app --bind 0.0.0.0:$PORT`;
      if (!dep('gunicorn')) pipExtra.push('gunicorn');
    } else if (await exists('main.py')) {
      start = 'python main.py';
      notes.push('started with "python main.py": the app must listen on 0.0.0.0:$PORT');
    } else if (await exists('app.py')) {
      start = 'python app.py';
      notes.push('started with "python app.py": the app must listen on 0.0.0.0:$PORT');
    }
  }
  if (!start) {
    throw new DetectError(
      'Python project detected, but the start command could not be guessed: add a Procfile (web: …), ' +
        'set "Start command", or add a Dockerfile',
    );
  }

  const forcedPort = forcedPortIn(start);
  return {
    stack: 'python',
    label,
    port: forcedPort ?? 8000,
    ...(forcedPort ? { forcedPort } : {}),
    install,
    build: o.build_command,
    start,
    image: `python:${pythonVersion(pyVersion ?? runtime)}-slim`,
    pipExtra,
    venv,
    notes,
  };
}

async function detectGo(src: FileSource, o: Overrides): Promise<Detection | null> {
  const mod = await src.read('go.mod');
  if (mod === null) return null;
  const version = /^go\s+(\d+\.\d+)/m.exec(mod)?.[1] ?? '1.23';

  // Paquet main à la racine, sinon un seul dossier sous cmd/.
  let target: string | null = null;
  for (const f of (await src.list('.')).filter((e) => e.endsWith('.go') && !e.endsWith('_test.go'))) {
    if (/^package main\b/m.test((await src.read(f)) ?? '')) {
      target = '.';
      break;
    }
  }
  if (!target) {
    const cmds = (await src.list('cmd')).filter((e) => e.endsWith('/'));
    if (cmds.length === 1) target = `./cmd/${cmds[0]!.slice(0, -1)}`;
    else if (cmds.length > 1) {
      throw new DetectError(
        `several commands in cmd/ (${cmds.join(', ')}): set the "Build command", e.g. go build -o /out/server ./cmd/api`,
      );
    }
  }
  if (!target && !o.build_command) throw new DetectError('Go module without a main package at the root or in cmd/');

  return {
    stack: 'go',
    label: 'Go',
    port: 8080,
    build: o.build_command,
    start: o.start_command,
    image: `golang:${version}-alpine`,
    goTarget: target ?? '.',
    notes: [],
  };
}

/** Détecte la stack ; lève DetectError avec un message explicite si rien ne correspond. */
export async function detect(src: FileSource, overrides: Overrides = {}): Promise<Detection> {
  const pkg = await src.read('package.json');
  if (pkg !== null) {
    const parsed = parseJson<PackageJson>(pkg);
    if (!parsed) throw new DetectError('unreadable package.json (invalid JSON)');
    return detectNode(src, parsed, overrides);
  }
  const py = await detectPython(src, overrides);
  if (py) return py;
  const go = await detectGo(src, overrides);
  if (go) return go;
  if ((await src.read('index.html')) !== null) {
    return { stack: 'static', label: 'Static site', port: 80, image: 'nginx:1.27-alpine', notes: [] };
  }
  if ((await src.read('Cargo.toml')) !== null) throw new DetectError('Rust project: add a Dockerfile (not auto-detected yet)');
  if ((await src.read('composer.json')) !== null) throw new DetectError('PHP project: add a Dockerfile (not auto-detected yet)');
  if ((await src.read('Gemfile')) !== null) throw new DetectError('Ruby project: add a Dockerfile (not auto-detected yet)');
  throw new DetectError(
    'no supported stack found (no Dockerfile, package.json, requirements.txt/pyproject.toml, go.mod, or index.html)',
  );
}

// --- Génération du Dockerfile ---

/** Commande shell dans un CMD, avec `exec` pour que l'app reçoive les signaux d'arrêt. */
const shellCmd = (cmd: string) => `CMD ["sh", "-c", ${JSON.stringify(`exec ${cmd}`)}]`;
const args = (keys: string[]) => keys.map((k) => `ARG ${k}`).join('\n');

/** Config nginx : écoute sur le port du projet, fallback SPA sur index.html. */
function nginxConf(port: number, spa: boolean): string {
  const fallback = spa ? '/index.html' : '=404';
  const conf =
    `server { listen ${port}; root /usr/share/nginx/html; index index.html; ` +
    `location / { try_files $uri $uri/ $uri.html ${fallback}; } ` +
    `location ~* \\.(js|css|woff2?|png|jpg|jpeg|gif|svg|ico|webp)$ { expires 7d; add_header Cache-Control "public"; try_files $uri =404; } }`;
  // Entre apostrophes : le shell ne doit pas remplacer $uri (variable nginx) par du vide.
  return `RUN printf '%s\\n' '${conf}' > /etc/nginx/conf.d/default.conf`;
}

export function renderDockerfile(d: Detection, opts: { port: number; buildArgKeys: string[] }): string {
  const { port } = opts;
  const header = `# Generated by Catalyst — ${d.label}\n`;
  const argLines = opts.buildArgKeys.length ? `${args(opts.buildArgKeys)}\n` : '';

  switch (d.stack) {
    case 'node':
    case 'bun':
      return (
        header +
        `FROM ${d.image}\n` +
        `WORKDIR /app\n` +
        `COPY . .\n` +
        argLines +
        `RUN ${d.install}\n` +
        (d.build ? `RUN ${d.build}\n` : '') +
        `ENV NODE_ENV=production PORT=${port} HOST=0.0.0.0 HOSTNAME=0.0.0.0 NITRO_PORT=${port}\n` +
        `EXPOSE ${port}\n` +
        `${shellCmd(d.start!)}\n`
      );

    case 'node-static':
    case 'bun-static': {
      const dirs = d.outputDirs ?? ['dist'];
      const find =
        `RUN set -e; for d in ${dirs.join(' ')} $(ls -d dist/*/browser 2>/dev/null); do ` +
        `if [ -f "$d/index.html" ]; then cp -r "$d" /site; exit 0; fi; done; ` +
        `echo "No index.html in ${dirs.join(', ')} after the build" >&2; exit 1`;
      return (
        header +
        `FROM ${d.image} AS build\n` +
        `WORKDIR /app\n` +
        `COPY . .\n` +
        argLines +
        `RUN ${d.install}\n` +
        `RUN ${d.build}\n` +
        `${find}\n\n` +
        `FROM nginx:1.27-alpine\n` +
        `${nginxConf(port, true)}\n` +
        `COPY --from=build /site /usr/share/nginx/html\n` +
        `EXPOSE ${port}\n`
      );
    }

    case 'static':
      return (
        header +
        `FROM nginx:1.27-alpine\n` +
        `${nginxConf(port, false)}\n` +
        `COPY . /usr/share/nginx/html\n` +
        `EXPOSE ${port}\n`
      );

    case 'python':
      return (
        header +
        `FROM ${d.image}\n` +
        `WORKDIR /app\n` +
        `ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1\n` +
        `COPY . .\n` +
        argLines +
        `RUN ${d.install}\n` +
        (d.venv ? `ENV PATH="/app/.venv/bin:$PATH"\n` : '') +
        (d.pipExtra?.length ? `RUN pip install ${d.pipExtra.join(' ')}\n` : '') +
        (d.label === 'Django' ? `RUN python manage.py collectstatic --noinput || true\n` : '') +
        (d.build ? `RUN ${d.build}\n` : '') +
        `ENV PORT=${port}\n` +
        `EXPOSE ${port}\n` +
        `${shellCmd(d.start!)}\n`
      );

    case 'go':
      return (
        header +
        `FROM ${d.image} AS build\n` +
        `WORKDIR /src\n` +
        `COPY . .\n` +
        argLines +
        `ENV CGO_ENABLED=0\n` +
        `RUN ${d.build ?? `go build -trimpath -ldflags="-s -w" -o /out/server ${d.goTarget}`}\n\n` +
        `FROM alpine:3.20\n` +
        `RUN apk add --no-cache ca-certificates tzdata\n` +
        `COPY --from=build /out/server /server\n` +
        `ENV PORT=${port}\n` +
        `EXPOSE ${port}\n` +
        (d.start ? `${shellCmd(d.start)}\n` : `CMD ["/server"]\n`)
      );
  }
}

/** .dockerignore ajouté si le repo n'en a pas (accélère le build, évite d'embarquer .git). */
export const DEFAULT_DOCKERIGNORE = ['.git', 'node_modules', '.venv', '__pycache__', '.next/cache', 'Dockerfile.catalyst', ''].join('\n');
