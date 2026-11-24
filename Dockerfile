# Image de Catalyst : API + worker + interface web.
# Contexte de build = racine du monorepo, voir apps/backend/docker-compose.yml.

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci
COPY apps/frontend apps/frontend
COPY apps/backend/tsconfig.json apps/backend/tsconfig.build.json apps/backend/
COPY apps/backend/src apps/backend/src
RUN npm run build

# Dépendances de production du backend seulement (hissées dans /repo/node_modules).
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci --omit=dev -w @catalyst/backend

FROM node:22-alpine
RUN apk add --no-cache git docker-cli docker-cli-buildx tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/backend/dist ./dist
COPY --from=build /repo/apps/frontend/dist ./web
COPY apps/backend/package.json ./
COPY apps/backend/migrations ./migrations
RUN ln -s /app/dist/cli/index.js /usr/local/bin/catalyst && chmod +x /app/dist/cli/index.js
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
