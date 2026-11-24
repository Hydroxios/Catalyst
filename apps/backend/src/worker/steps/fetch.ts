import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Ctx } from '../../context.js';
import type { ProjectRow } from '../../db/schema.js';
import { runCommand } from '../../utils/command.js';
import { sleep } from '../../utils/time.js';
import { StepError } from '../errors.js';
import type { DeploymentLogger } from '../logger.js';

export interface FetchResult {
  dir: string;
  commitMessage: string | null;
  commitAuthor: string | null;
}

/**
 * Supprime les verrous laissés par un git interrompu (arrêt brutal du serveur pendant un fetch) :
 * sans ça, toutes les commandes suivantes échouent (« Another git process seems to be running »).
 * Sans risque : un seul déploiement à la fois par projet (garanti en base), donc aucun autre git
 * ne travaille sur ce clone.
 */
export function removeStaleLocks(gitDir: string): string[] {
  const removed: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        // Les objets ne contiennent jamais de verrous ; inutile de les parcourir.
        if (e.name !== 'objects') walk(path);
      } else if (e.name.endsWith('.lock')) {
        rmSync(path, { force: true });
        removed.push(path.slice(gitDir.length + 1));
      }
    }
  };
  walk(gitDir);
  return removed;
}

/**
 * Récupère le code au SHA demandé (plan §10.1). Le token passe par un en-tête HTTP
 * (`http.extraHeader`) au lieu de l'URL : il n'est jamais écrit dans .git/config.
 * En cas d'échec (réseau, clone local abîmé), un second essai repart d'un clone neuf.
 */
export async function fetchSource(
  ctx: Ctx,
  project: ProjectRow,
  sha: string,
  logger: DeploymentLogger,
  signal: AbortSignal,
): Promise<FetchResult> {
  const dir = join(ctx.env.WORKDIR, project.slug);
  let token: string;
  try {
    ({ token } = await ctx.github.forRepo(project.repo));
  } catch (err) {
    throw new StepError((err as Error).message);
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  logger.addSecret(basic);
  logger.addSecret(token);
  const auth = ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
  const url = `https://github.com/${project.repo}.git`;
  const branch = project.branch;

  const git = (args: string[], opts: { cwd?: string } = {}) =>
    runCommand('git', [...auth, ...args], {
      cwd: opts.cwd,
      signal,
      timeoutMs: 5 * 60_000,
      label: `git ${args[0]}`,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      onLine: (stream, line) => logger.push(stream, line),
    });

  const sync = async () => {
    if (!existsSync(join(dir, '.git'))) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dirname(dir), { recursive: true });
      await git(['clone', '--filter=blob:none', '--no-checkout', url, dir]);
    } else {
      const removed = removeStaleLocks(join(dir, '.git'));
      if (removed.length > 0) logger.system(`ℹ removed stale git locks: ${removed.join(', ')}`);
      await git(['remote', 'set-url', 'origin', url], { cwd: dir });
    }
    await git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`, '--prune'], { cwd: dir });
    // SHA absent de la branche (déploiement manuel d'un ancien commit, force-push) : on le demande directement.
    try {
      await runCommand('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: dir, signal });
    } catch {
      await git(['fetch', 'origin', sha], { cwd: dir });
    }
    await git(['checkout', '--force', '--detach', sha], { cwd: dir });
    await git(['clean', '-fdx'], { cwd: dir });
  };

  for (let attempt = 1; ; attempt++) {
    try {
      await sync();
      break;
    } catch (err) {
      if (signal.aborted) throw err;
      if (attempt >= 2) throw new StepError(`could not fetch the code: ${(err as Error).message}`);
      // Erreur réseau passagère ou clone local abîmé (arrêt brutal pendant un fetch) : on repart de zéro.
      logger.system(`⚠ ${(err as Error).message} — retrying with a fresh clone in 3s`);
      rmSync(dir, { recursive: true, force: true });
      await sleep(3_000, signal);
    }
  }

  let commitMessage: string | null = null;
  let commitAuthor: string | null = null;
  try {
    const out = await runCommand('git', ['log', '-1', '--format=%an%x00%s', sha], { cwd: dir, signal });
    const [author, message] = (out[out.length - 1] ?? '').split('\0');
    commitAuthor = author || null;
    commitMessage = message || null;
  } catch {
    // purement informatif
  }
  return { dir, commitMessage, commitAuthor };
}
