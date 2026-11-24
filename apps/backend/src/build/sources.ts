import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { FileSource } from './detect.js';

const MAX_FILE = 512 * 1024;

/** Fichiers du repo cloné (au moment du build). */
export function fsSource(root: string): FileSource {
  return {
    async read(path) {
      try {
        const buf = await readFile(join(root, path));
        return buf.subarray(0, MAX_FILE).toString('utf8');
      } catch {
        return null;
      }
    },
    async list(dir) {
      try {
        const entries = await readdir(join(root, dir), { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      } catch {
        return [];
      }
    },
  };
}

/** Fichiers du repo via l'API GitHub (aperçu à l'import, sans cloner). Résultats mis en cache. */
export function githubSource(octokit: Octokit, repo: string, ref: string, base = '.'): FileSource {
  const [owner = '', name = ''] = repo.split('/');
  const cache = new Map<string, Promise<unknown>>();
  const fetchPath = (path: string) => {
    const full = posix.normalize(posix.join(base, path)).replace(/^\.\/?$/, '');
    let p = cache.get(full);
    if (!p) {
      p = octokit.rest.repos
        .getContent({ owner, repo: name, path: full, ref })
        .then((r) => r.data)
        .catch((err: { status?: number }) => {
          if (err.status === 404) return null;
          throw err;
        });
      cache.set(full, p);
    }
    return p;
  };
  return {
    async read(path) {
      const data = (await fetchPath(path)) as { type?: string; content?: string; encoding?: string } | null;
      if (!data || Array.isArray(data) || data.type !== 'file') return null;
      // Fichiers volumineux (lockfiles) : seule leur existence compte.
      if (!data.content) return '';
      return Buffer.from(data.content, 'base64').subarray(0, MAX_FILE).toString('utf8');
    },
    async list(dir) {
      const data = (await fetchPath(dir)) as { name: string; type: string }[] | null;
      if (!Array.isArray(data)) return [];
      return data.map((e) => (e.type === 'dir' ? `${e.name}/` : e.name));
    },
  };
}
