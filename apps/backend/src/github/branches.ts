import type { Octokit } from '@octokit/rest';
import { firstLine, splitRepo } from './client.js';

export interface BranchInfo {
  name: string;
  sha: string;
  /** Date du dernier commit (ISO), null si inconnue. */
  date: string | null;
  message: string | null;
  author: string | null;
  isDefault: boolean;
}

export interface CommitInfo {
  sha: string;
  message: string | null;
  author: string | null;
  date: string | null;
}

interface RefsQuery {
  repository: {
    defaultBranchRef: { name: string } | null;
    refs: {
      nodes: {
        name: string;
        target: {
          oid?: string;
          committedDate?: string;
          messageHeadline?: string;
          author?: { name?: string | null; user?: { login: string } | null } | null;
        };
      }[];
    };
  };
}

/** Plus récemment poussée d'abord ; sans date, la branche par défaut puis l'ordre alphabétique. */
export function sortByActivity(branches: BranchInfo[]): BranchInfo[] {
  return [...branches].sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date || b.date) return a.date ? -1 : 1;
    return Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name);
  });
}

/**
 * Branches du repo, les plus récemment poussées d'abord (une seule requête GraphQL).
 * Repli REST (noms seuls) si GraphQL n'est pas disponible.
 */
export async function listBranchesByActivity(octokit: Octokit, repo: string, limit = 100): Promise<BranchInfo[]> {
  const { owner, name } = splitRepo(repo);
  try {
    const data = await octokit.graphql<RefsQuery>(
      `query ($owner: String!, $name: String!, $limit: Int!) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef { name }
          refs(refPrefix: "refs/heads/", first: $limit) {
            nodes {
              name
              target {
                ... on Commit {
                  oid
                  committedDate
                  messageHeadline
                  author { name user { login } }
                }
              }
            }
          }
        }
      }`,
      { owner, name, limit },
    );
    const def = data.repository.defaultBranchRef?.name;
    // L'ordre TAG_COMMIT_DATE de GitHub ne trie pas les branches par date de commit : on trie nous-mêmes.
    return sortByActivity(data.repository.refs.nodes.map((n) => ({
      name: n.name,
      sha: n.target.oid ?? '',
      date: n.target.committedDate ?? null,
      message: n.target.messageHeadline ?? null,
      author: n.target.author?.user?.login ?? n.target.author?.name ?? null,
      isDefault: n.name === def,
    })));
  } catch {
    const [branches, repoInfo] = await Promise.all([
      octokit.paginate(octokit.rest.repos.listBranches, { owner, repo: name, per_page: 100 }),
      octokit.rest.repos.get({ owner, repo: name }),
    ]);
    const def = repoInfo.data.default_branch;
    return sortByActivity(
      branches.map((b) => ({ name: b.name, sha: b.commit.sha, date: null, message: null, author: null, isDefault: b.name === def })),
    );
  }
}

/** Derniers commits d'une branche (pour « Déployer un commit »). */
export async function listRecentCommits(octokit: Octokit, repo: string, branch: string, limit = 20): Promise<CommitInfo[]> {
  const { owner, name } = splitRepo(repo);
  const { data } = await octokit.rest.repos.listCommits({ owner, repo: name, sha: branch, per_page: limit });
  return data.map((c) => ({
    sha: c.sha,
    message: firstLine(c.commit.message),
    author: c.author?.login ?? c.commit.author?.name ?? null,
    date: c.commit.author?.date ?? c.commit.committer?.date ?? null,
  }));
}
