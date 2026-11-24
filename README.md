# Catalyst — plateforme de déploiement automatique

Implémentation de [plan-deploy-auto.md](plan-deploy-auto.md), avec une interface web.
Tu importes un repo GitHub, Catalyst le construit dans Docker et le met en ligne derrière Traefik (HTTPS).
Ensuite, chaque push sur la branche suivie est redéployé sans coupure, avec rollback possible.

```
push GitHub ─▶ /webhooks/github ─┐
poll GitHub (ETag) ──────────────┴▶ jobs (Postgres, SKIP LOCKED) ─▶ worker :
   fetch (git) → build (docker build, tag SHA) → start (labels Traefik + healthcheck)
   → healthcheck ×3 → retrait de l'ancien conteneur → live
```

Monorepo npm (workspaces) :

| Dossier | Contenu |
|---|---|
| `apps/backend/` (`@catalyst/backend`) | API, receiver de webhooks, poller, worker, CLI (`catalyst`), `docker-compose.yml` |
| `apps/frontend/` (`@catalyst/frontend`) | Interface web (Vite + React), servie par le backend en production |
| `brand/` | Logos et icônes |
| `Dockerfile` | Image unique (backend + interface), construite depuis la racine |

## Installation sur le serveur

Prérequis : Docker Engine + plugin compose, ports 80/443 ouverts, et le DNS :
- `deploy.mondomaine.fr` (l'interface) → IP du serveur ;
- `*.mondomaine.fr` (wildcard, pour les sous-domaines automatiques) → IP du serveur.

```bash
cd apps/backend
cp .env.example .env     # remplir : ADMIN_TOKEN, POSTGRES_PASSWORD, domaines, e-mail ACME
docker compose up -d --build
```

Puis ouvre `https://deploy.mondomaine.fr` :

1. Connecte-toi avec le **token admin** (`ADMIN_TOKEN`), une seule fois.
2. **Réglages → Connecter GitHub** : Catalyst crée une GitHub App privée (flux « manifest » de GitHub,
   pas de clé à copier). Le compte GitHub qui la crée devient admin.
3. Sur GitHub, choisis les repos auxquels Catalyst a accès.
4. Déconnecte-toi, puis **Continuer avec GitHub**. Désormais : **Importer un repo** → Déployer.

Avec la GitHub App, il n'y a ni token GitHub permanent ni webhook à configurer repo par repo. Les tokens
d'accès sont de courte durée (1 h), un seul webhook (celui de l'App) couvre tous les repos, et les permissions
se limitent au code en lecture et aux statuts de commit.

Accès à l'interface : seuls les comptes GitHub listés dans **Réglages → Accès** (ou `CATALYST_ADMINS`)
peuvent se connecter. Catalyst pilote Docker sur le serveur, ce qui revient à un accès root.

> Mode sans GitHub App (historique) : renseigner `GITHUB_TOKEN` + `GITHUB_WEBHOOK_SECRET` dans `.env`.
> L'interface propose alors de créer le webhook de chaque repo automatiquement.

## Tester en local (Windows + WSL2, sans Docker Desktop)

Mode local : HTTP seulement, interface sur `http://catalyst.localhost`, projets sur `http://<slug>.localhost`.
Les navigateurs résolvent `*.localhost` vers ta machine, donc aucun DNS à configurer.

1. Dans un PowerShell **administrateur**, puis redémarre le PC :
   ```powershell
   wsl --install -d Ubuntu
   ```
2. Dans le terminal Ubuntu :
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER   # puis ferme et rouvre le terminal Ubuntu
   cd /mnt/f/Catalyst/apps/backend
   docker compose -f docker-compose.local.yml up -d --build
   ```
3. Ouvre `http://catalyst.localhost` dans ton navigateur Windows, puis connecte-toi avec le token
   `catalyst-local-admin` (modifiable dans `.env.local`).
4. Va dans **Réglages → Connecter GitHub**. Crée une App dédiée au local, distincte de celle du serveur.
5. Importe un repo : il sera servi sur `http://<slug>.localhost`.

En local, GitHub ne peut pas joindre ta machine : les nouveaux commits sont détectés par **polling toutes
les 30 s**. Pour des pushs instantanés, configure un relais smee.io (voir `.env.local.example`) **avant**
de connecter GitHub.

Pour arrêter : `docker compose -f docker-compose.local.yml down`. Ajoute `-v` pour tout effacer, y compris
la base et l'App enregistrée.

## Repos sans Dockerfile

Si le repo n'a pas de Dockerfile, Catalyst détecte la stack et en génère un. Le Dockerfile généré est
affiché dans les logs du build.

| Stack | Détection | Port par défaut |
|---|---|---|
| Next.js, Nuxt, Remix, SvelteKit (adapter-node), Astro (node), NestJS, Express, Fastify… | `package.json` (npm, pnpm, yarn ou bun selon le lockfile) | 3000 |
| SPA Vite / React / Angular / SvelteKit statique / Astro statique | `package.json` avec un build et sans serveur : servie par nginx | 80 |
| Django, FastAPI, Flask, Procfile | `requirements.txt`, `pyproject.toml` (uv, poetry) ou `Pipfile` | 8000 |
| Go | `go.mod` (main à la racine ou dans `cmd/<nom>`) | 8080 |
| Site statique | `index.html` à la racine | 80 |

L'app reçoit la variable `PORT` (le port du projet) et doit écouter sur `0.0.0.0`.
Si la détection se trompe, renseigne la **commande de build** ou la **commande de démarrage** dans les paramètres
du projet. Rust, PHP et Ruby demandent pour l'instant un Dockerfile.

## Domaine racine (sans sous-domaine)

Dans le formulaire d'un projet, choisis **Domaine personnalisé**, puis :
- saisis `mondomaine.fr` (ou n'importe quel autre domaine, plusieurs possibles) ;
- coche **Rediriger www vers le domaine** pour que `www.mondomaine.fr` redirige (301) vers `mondomaine.fr`.

Côté DNS, le wildcard ne couvre pas la racine : crée un enregistrement **A** `@` (et `www`) vers l'IP du
serveur. L'onglet **Domaine & webhook** du projet vérifie le DNS et indique quoi configurer. Le certificat
HTTPS est obtenu automatiquement.

Si l'IP affichée n'est pas la bonne (serveur derrière un NAT, par exemple), renseigne `SERVER_IP`.

## CLI

```bash
docker compose exec catalyst catalyst status
```

Ou depuis un poste avec `CATALYST_URL=https://deploy.mondomaine.fr` et `CATALYST_TOKEN=<ADMIN_TOKEN>` :
`catalyst status | history | deploy | rollback | logs --follow | pause | resume | cancel`.

## Zéro coupure : deux modes (`healthcheck.mode`)

- **Sans coupure** (défaut) : le nouveau conteneur démarre avec un healthcheck Docker ; Traefik ne lui
  envoie du trafic qu'une fois `healthy`. **L'image doit contenir `wget` ou `curl`.**
- **Simple** : Catalyst teste l'app lui-même puis recrée le conteneur routé (~1 s de coupure possible).

Un build cassé, une app qui crashe ou un healthcheck en échec ne touchent jamais la version en ligne.

## Développement

Tout se lance depuis la racine (un seul `npm install`, un seul `package-lock.json`) :

```bash
npm install
cp apps/backend/.env.dev.example apps/backend/.env.dev   # config du backend en dev
npm run dev                                # Postgres embarqué (:5433) + backend (:3000) + frontend (http://localhost:5173)
npm run dev:backend                        # ou l'un des deux seulement (dev:frontend)
npm test                                   # unitaires + webhook + GitHub App (Postgres et Docker pour tout le reste)
TEST_DATABASE_URL=postgres://... npm test  # + intégration de la file de jobs (base dédiée, vidée)
npm run typecheck                          # les deux apps
npm run build                              # frontend puis backend
npm run cli -- status                      # CLI catalyst
```

En dev, Postgres est un binaire natif lancé par `npm run dev` (`embedded-postgres`, données dans
`apps/backend/.catalyst/pg`) : ni Docker ni WSL. Le backend tourne en `ROLE=api` (pas de worker, `/health` en
`degraded` sans Docker) ; pour builder et déployer depuis le dev, mets `ROLE=all` là où Docker est accessible.

Pour une commande propre à une app : `npm run <script> -w @catalyst/backend` (ou `@catalyst/frontend`).
Une dépendance s'ajoute de la même façon : `npm install <paquet> -w @catalyst/frontend`.

En dev avec la connexion GitHub, mets `PUBLIC_URL=http://localhost:5173` : les redirections GitHub
passent par le proxy Vite.

## Écarts par rapport au plan

- `pg` brut + `migrations/*.sql` (pas Drizzle), migrations appliquées au démarrage.
- Projets gérés depuis l'interface, en base. `projects.yml` reste supporté (projets en lecture seule dans l'UI).
- Accès GitHub par GitHub App (le plan la prévoyait « plus tard ») ; token personnel en repli.
- Conteneurs nommés `<slug>-<sha12>-<id>` : l'id du déploiement évite un conflit de nom quand on redéploie un SHA déjà en ligne.
- Pause : colonne `paused` dédiée. Jobs avec heartbeat : orphelins détectés en 2 min.
- Le token git passe par `http.extraHeader` et n'est jamais écrit dans `.git/config` ni dans les logs.
- Supprimer un projet arrête son site et garde l'historique.
- Alerte disque : mesurée sur le volume `/var/lib/catalyst`.
