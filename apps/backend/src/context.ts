import type Docker from 'dockerode';
import type { Logger } from 'pino';
import type { Env } from './config/env.js';
import type { Db } from './db/client.js';
import type { GitHubService } from './github/service.js';
import type { SettingsStore } from './settings.js';

/** Dépendances partagées par tous les modules. */
export interface Ctx {
  env: Env;
  db: Db;
  log: Logger;
  docker: Docker;
  github: GitHubService;
  settings: SettingsStore;
}
