import type { Ctx } from '../context.js';
import { splitRepo } from './client.js';

export type CommitState = 'pending' | 'success' | 'failure' | 'error';

/**
 * Statut de commit GitHub (plan §14.2). Ne fait jamais échouer un déploiement :
 * une erreur est seulement loggée (ex. token sans la permission Commit statuses).
 */
export async function setCommitStatus(
  ctx: Ctx,
  repo: string,
  sha: string,
  state: CommitState,
  description: string,
  targetUrl?: string,
): Promise<void> {
  const { owner, name } = splitRepo(repo);
  try {
    const { octokit } = await ctx.github.forRepo(repo);
    await octokit.rest.repos.createCommitStatus({
      owner,
      repo: name,
      sha,
      state,
      context: 'catalyst',
      description: description.slice(0, 140),
      ...(targetUrl ? { target_url: targetUrl } : {}),
    });
  } catch (err) {
    ctx.log.warn({ err, repo, sha, state }, 'could not update the GitHub commit status');
  }
}
