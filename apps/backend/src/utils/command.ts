import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly tail: string[],
  ) {
    super(message);
  }
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
  /** Texte affiché dans les erreurs à la place de la ligne de commande réelle (qui peut contenir un secret). */
  label?: string;
}

/**
 * Lance une commande, streame stdout/stderr ligne par ligne, et rejette si
 * le code de sortie n'est pas 0, si le timeout expire ou si `signal` est déclenché.
 */
export function runCommand(cmd: string, args: string[], opts: RunOptions = {}): Promise<string[]> {
  const label = opts.label ?? cmd;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new CommandError(`${label}: cancelled`, null, []));
      return;
    }
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const tail: string[] = [];
    const record = (stream: 'stdout' | 'stderr') => (line: string) => {
      tail.push(line);
      if (tail.length > 50) tail.shift();
      opts.onLine?.(stream, line);
    };
    createInterface({ input: child.stdout }).on('line', record('stdout'));
    createInterface({ input: child.stderr }).on('line', record('stderr'));

    let killedReason: string | null = null;
    const kill = (reason: string) => {
      if (killedReason) return;
      killedReason = reason;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => kill(`timed out (${Math.round(opts.timeoutMs! / 1000)}s)`), opts.timeoutMs)
      : null;
    const onAbort = () => kill('cancelled');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      cleanup();
      reject(new CommandError(`${label}: ${err.message}`, null, tail));
    });
    child.on('close', (code) => {
      cleanup();
      if (killedReason) reject(new CommandError(`${label}: ${killedReason}`, code, tail));
      else if (code !== 0) reject(new CommandError(`${label}: exit code ${code}`, code, tail));
      else resolve(tail);
    });
  });
}
