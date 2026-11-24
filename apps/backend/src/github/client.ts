import type { Octokit } from '@octokit/rest';

export function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = '', name = ''] = repo.split('/');
  return { owner, name };
}

export interface BranchHead {
  sha: string;
  message: string | null;
  author: string | null;
}

export type HeadResult =
  | { kind: 'not_modified' }
  | { kind: 'ok'; etag: string | null; head: BranchHead };

export class RateLimitError extends Error {
  constructor(public readonly resetAt: Date) {
    super(`GitHub API quota exhausted until ${resetAt.toISOString()}`);
  }
}

interface HttpError {
  status: number;
  response?: { headers?: Record<string, string | number | undefined> };
}

function isHttpError(err: unknown): err is HttpError {
  return typeof err === 'object' && err !== null && typeof (err as HttpError).status === 'number';
}

export function firstLine(message: string | null | undefined): string | null {
  if (!message) return null;
  return message.split('\n', 1)[0]!.slice(0, 500);
}

/**
 * Dernier commit d'une branche. Avec `etag`, GitHub répond 304 si rien n'a changé
 * (et la requête ne compte pas dans le quota) — plan §8.
 */
export async function getBranchHead(
  gh: Octokit,
  repo: string,
  branch: string,
  etag?: string | null,
): Promise<HeadResult> {
  const { owner, name } = splitRepo(repo);
  try {
    const res = await gh.request('GET /repos/{owner}/{repo}/commits/{ref}', {
      owner,
      repo: name,
      ref: branch,
      headers: etag ? { 'if-none-match': etag } : {},
    });
    return {
      kind: 'ok',
      etag: res.headers.etag ?? null,
      head: {
        sha: res.data.sha,
        message: firstLine(res.data.commit.message),
        author: res.data.commit.author?.name ?? res.data.author?.login ?? null,
      },
    };
  } catch (err) {
    if (isHttpError(err)) {
      if (err.status === 304) return { kind: 'not_modified' };
      const headers = err.response?.headers ?? {};
      if ((err.status === 403 || err.status === 429) && String(headers['x-ratelimit-remaining']) === '0') {
        const reset = Number(headers['x-ratelimit-reset']);
        throw new RateLimitError(new Date(Number.isFinite(reset) ? reset * 1000 : Date.now() + 15 * 60_000));
      }
    }
    throw err;
  }
}
