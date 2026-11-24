# Catalyst — automatic deployment platform

Self-hosted deployment platform with a web interface.
You import a GitHub repo, Catalyst builds it in Docker and puts it online behind Traefik (HTTPS).
From then on, every push to the tracked branch is redeployed with zero downtime, and you can roll back.

```
GitHub push ─▶ /webhooks/github ─┐
GitHub poll (ETag) ──────────────┴▶ jobs (Postgres, SKIP LOCKED) ─▶ worker:
   fetch (git) → build (docker build, SHA tag) → start (Traefik labels + healthcheck)
   → healthcheck ×3 → remove the old container → live
```

npm monorepo (workspaces):

| Folder | Contents |
|---|---|
| `apps/backend/` (`@catalyst/backend`) | API, webhook receiver, poller, worker, CLI (`catalyst`), `docker-compose.yml` |
| `apps/frontend/` (`@catalyst/frontend`) | Web interface (Vite + React), served by the backend in production |
| `brand/` | Logos and icons |
| `Dockerfile` | Single image (backend + interface), built from the root |

## Server installation

Requirements: Docker Engine + compose plugin, ports 80/443 open, and DNS:
- `deploy.mydomain.com` (the interface) → server IP;
- `*.mydomain.com` (wildcard, for automatic subdomains) → server IP.

```bash
cd apps/backend
cp .env.example .env     # fill in: ADMIN_TOKEN, POSTGRES_PASSWORD, domains, ACME e-mail
docker compose up -d --build
```

Then open `https://deploy.mydomain.com`:

1. Sign in with the **admin token** (`ADMIN_TOKEN`), just once.
2. **Settings → Connect GitHub**: Catalyst creates a private GitHub App (GitHub's "manifest" flow,
   no key to copy). The GitHub account that creates it becomes admin.
3. On GitHub, choose which repos Catalyst can access.
4. Sign out, then **Continue with GitHub**. From now on: **Import a repo** → Deploy.

With the GitHub App, there is no long-lived GitHub token and no per-repo webhook to configure. Access
tokens are short-lived (1 h), a single webhook (the App's) covers every repo, and permissions are limited
to read access on code and commit statuses.

Interface access: only the GitHub accounts listed in **Settings → Access** (or `CATALYST_ADMINS`)
can sign in. Catalyst controls Docker on the server, which amounts to root access.

> Mode without a GitHub App (legacy): set `GITHUB_TOKEN` + `GITHUB_WEBHOOK_SECRET` in `.env`.
> The interface then offers to create each repo's webhook automatically.

## Local testing (Windows + WSL2, without Docker Desktop)

Local mode: HTTP only, interface at `http://catalyst.localhost`, projects at `http://<slug>.localhost`.
Browsers resolve `*.localhost` to your machine, so there is no DNS to configure.

1. In an **administrator** PowerShell, then restart the PC:
   ```powershell
   wsl --install -d Ubuntu
   ```
2. In the Ubuntu terminal:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER   # then close and reopen the Ubuntu terminal
   cd /mnt/f/Catalyst/apps/backend
   docker compose -f docker-compose.local.yml up -d --build
   ```
3. Open `http://catalyst.localhost` in your Windows browser, then sign in with the token
   `catalyst-local-admin` (configurable in `.env.local`).
4. Go to **Settings → Connect GitHub**. Create an App dedicated to local use, separate from the server's.
5. Import a repo: it will be served at `http://<slug>.localhost`.

Locally, GitHub cannot reach your machine: new commits are detected by **polling every 30 s**.
For instant pushes, set up a smee.io relay (see `.env.local.example`) **before** connecting GitHub.

To stop: `docker compose -f docker-compose.local.yml down`. Add `-v` to wipe everything, including
the database and the registered App.

## Repos without a Dockerfile

If the repo has no Dockerfile, Catalyst detects the stack and generates one. The generated Dockerfile is
shown in the build logs.

| Stack | Detection | Default port |
|---|---|---|
| Next.js, Nuxt, Remix, SvelteKit (adapter-node), Astro (node), NestJS, Express, Fastify… | `package.json` (npm, pnpm, yarn or bun depending on the lockfile) | 3000 |
| Vite / React / Angular SPA, static SvelteKit, static Astro | `package.json` with a build and no server: served by nginx | 80 |
| Django, FastAPI, Flask, Procfile | `requirements.txt`, `pyproject.toml` (uv, poetry) or `Pipfile` | 8000 |
| Go | `go.mod` (main at the root or in `cmd/<name>`) | 8080 |
| Static site | `index.html` at the root | 80 |

The app receives the `PORT` variable (the project's port) and must listen on `0.0.0.0`.
If detection gets it wrong, set the **build command** or **start command** in the project settings.
Rust, PHP and Ruby currently require a Dockerfile.

## Apex domain (no subdomain)

In a project's form, choose **Custom domain**, then:
- enter `mydomain.com` (or any other domain; several are allowed);
- check **Redirect www to the domain** so that `www.mydomain.com` redirects (301) to `mydomain.com`.

On the DNS side, the wildcard does not cover the apex: create an **A** record for `@` (and `www`) pointing
to the server IP. The project's **Domain & webhook** tab checks DNS and tells you what to configure. The HTTPS
certificate is obtained automatically.

If the displayed IP is wrong (server behind NAT, for example), set `SERVER_IP`.

## CLI

```bash
docker compose exec catalyst catalyst status
```

Or from a workstation with `CATALYST_URL=https://deploy.mydomain.com` and `CATALYST_TOKEN=<ADMIN_TOKEN>`:
`catalyst status | history | deploy | rollback | logs --follow | pause | resume | cancel`.

## Zero downtime: two modes (`healthcheck.mode`)

- **Zero-downtime** (default): the new container starts with a Docker healthcheck; Traefik only sends
  it traffic once it is `healthy`. **The image must include `wget` or `curl`.**
- **Simple**: Catalyst tests the app itself, then recreates the routed container (~1 s of possible downtime).

A broken build, a crashing app or a failing healthcheck never affects the live version.

## Development

Everything runs from the root (a single `npm install`, a single `package-lock.json`):

```bash
npm install
cp apps/backend/.env.dev.example apps/backend/.env.dev   # backend dev config
npm run dev                                # embedded Postgres (:5433) + backend (:3000) + frontend (http://localhost:5173)
npm run dev:backend                        # or just one of them (dev:frontend)
npm test                                   # unit + webhook + GitHub App (Postgres and Docker for everything else)
TEST_DATABASE_URL=postgres://... npm test  # + job queue integration (dedicated database, wiped)
npm run typecheck                          # both apps
npm run build                              # frontend, then backend
npm run cli -- status                      # catalyst CLI
```

In dev, Postgres is a native binary started by `npm run dev` (`embedded-postgres`, data in
`apps/backend/.catalyst/pg`): no Docker, no WSL. The backend runs with `ROLE=api` (no worker, `/health` reports
`degraded` without Docker); to build and deploy from dev, set `ROLE=all` where Docker is available.

For an app-specific command: `npm run <script> -w @catalyst/backend` (or `@catalyst/frontend`).
Dependencies are added the same way: `npm install <package> -w @catalyst/frontend`.

In dev with the GitHub connection, set `PUBLIC_URL=http://localhost:5173`: GitHub redirects
go through the Vite proxy.

## Implementation notes

- Raw `pg` + `migrations/*.sql`, migrations applied at startup.
- Projects managed from the interface, stored in the database. `projects.yml` is still supported (read-only projects in the UI).
- GitHub access via a GitHub App; personal token as a fallback.
- Containers named `<slug>-<sha12>-<id>`: the deployment id avoids a name clash when redeploying a SHA that is already live.
- Pause: dedicated `paused` column. Jobs with heartbeat: orphans detected within 2 min.
- The git token goes through `http.extraHeader` and is never written to `.git/config` or to the logs.
- Deleting a project stops its site and keeps its history.
- Disk alert: measured on the `/var/lib/catalyst` volume.

## License

[MIT](LICENSE)
