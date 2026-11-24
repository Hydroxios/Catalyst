import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeStaleLocks } from '../src/worker/steps/fetch.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString();

describe('verrous git orphelins', () => {
  it('débloque un clone laissé verrouillé par un git interrompu', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalyst-git-'));
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'a');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    const sha = git(dir, 'rev-parse', 'HEAD').trim();

    // Arrêt brutal pendant une opération git : verrous laissés sur l'index et une ref.
    writeFileSync(join(dir, '.git', 'index.lock'), '');
    mkdirSync(join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    writeFileSync(join(dir, '.git', 'refs', 'remotes', 'origin', 'main.lock'), '');
    expect(() => git(dir, 'checkout', '--force', '--detach', sha)).toThrow(/index\.lock/);

    const removed = removeStaleLocks(join(dir, '.git'));
    expect(removed.map((r) => r.replace(/\\/g, '/')).sort()).toEqual(['index.lock', 'refs/remotes/origin/main.lock']);
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(false);
    expect(() => git(dir, 'checkout', '--force', '--detach', sha)).not.toThrow();
  });

  it('ne fait rien sur un dossier absent', () => {
    expect(removeStaleLocks(join(tmpdir(), 'catalyst-inexistant-xyz', '.git'))).toEqual([]);
  });
});
