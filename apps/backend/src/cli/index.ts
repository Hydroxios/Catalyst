#!/usr/bin/env node
/**
 * CLI `catalyst` (plan §15) : simple client de l'API interne.
 *   CATALYST_URL   (défaut http://localhost:3000)
 *   CATALYST_TOKEN (ou ADMIN_TOKEN)
 */

const USAGE = `Usage :
  catalyst status
  catalyst history <slug> [--limit 20]
  catalyst deploy <slug> [--sha <sha>]
  catalyst rollback <slug> [--to <deploymentId>]
  catalyst logs <slug|deploymentId> [--follow]
  catalyst pause <slug> | resume <slug>
  catalyst cancel <deploymentId>`;

const baseUrl = (process.env.CATALYST_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const token = process.env.CATALYST_TOKEN ?? process.env.ADMIN_TOKEN ?? '';

interface Deployment {
  id: number;
  sha: string;
  status: string;
  trigger: string;
  commit_message: string | null;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

class CliError extends Error {}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!token) throw new CliError('CATALYST_TOKEN is missing');
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    throw new CliError(`${res.status} ${(data as { error?: string } | null)?.error ?? res.statusText}`);
  }
  return data as T;
}

function ago(iso: string | null): string {
  if (!iso) return '-';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

const statusIcon: Record<string, string> = {
  live: '✅',
  failed: '❌',
  queued: '⏳',
  fetching: '🔄',
  building: '🔨',
  starting: '🚀',
  healthchecking: '🩺',
  superseded: '⏭',
  cancelled: '■',
  rolled_back: '↩',
};

async function status(): Promise<void> {
  const projects = await api<
    {
      slug: string;
      repo: string;
      branch: string;
      paused: boolean;
      enabled: boolean;
      domains: string[];
      live: Deployment | null;
      latest: Deployment | null;
    }[]
  >('GET', '/projects');
  const rows = [['PROJECT', 'BRANCH', 'LIVE', 'LATEST DEPLOYMENT', 'URL']];
  for (const p of projects) {
    const flags = !p.enabled ? ' (removed)' : p.paused ? ' (paused)' : '';
    const live = p.live ? `${p.live.sha.slice(0, 7)} ${ago(p.live.finished_at)}` : '-';
    const latest = p.latest ? `${statusIcon[p.latest.status] ?? ''} ${p.latest.status} #${p.latest.id}` : '-';
    rows.push([p.slug + flags, p.branch, live, latest, p.domains?.[0] ? `https://${p.domains[0]}` : '-']);
  }
  console.log(table(rows));
}

async function history(slug: string, limit: string): Promise<void> {
  const deployments = await api<Deployment[]>('GET', `/projects/${slug}/deployments?limit=${encodeURIComponent(limit)}`);
  const rows = [['#', 'STATUS', 'SHA', 'TRIGGER', 'WHEN', 'MESSAGE']];
  for (const d of deployments) {
    rows.push([
      String(d.id),
      `${statusIcon[d.status] ?? ''} ${d.status}`,
      d.sha.slice(0, 7),
      d.trigger,
      ago(d.queued_at),
      (d.error ?? d.commit_message ?? '').slice(0, 60),
    ]);
  }
  console.log(table(rows));
}

async function resolveDeploymentId(target: string): Promise<number> {
  if (/^\d+$/.test(target)) return Number(target);
  const [latest] = await api<Deployment[]>('GET', `/projects/${target}/deployments?limit=1`);
  if (!latest) throw new CliError(`no deployment for ${target}`);
  return latest.id;
}

async function logs(target: string, follow: boolean): Promise<void> {
  const id = await resolveDeploymentId(target);
  if (!follow) {
    const res = await api<{ logs: { ts: string; stream: string; line: string }[] }>('GET', `/deployments/${id}/logs`);
    for (const l of res.logs) console.log(l.stream === 'system' ? l.line : `  ${l.line}`);
    return;
  }
  const res = await fetch(`${baseUrl}/api/deployments/${id}/logs?follow=1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok || !res.body) throw new CliError(`${res.status} ${res.statusText}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = /^event: (.*)$/m.exec(raw)?.[1];
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      if (!data) continue;
      const parsed = JSON.parse(data) as { stream?: string; line?: string; status?: string };
      if (event === 'end') {
        console.log(`\n${statusIcon[parsed.status ?? ''] ?? ''} finished: ${parsed.status}`);
        process.exitCode = parsed.status === 'live' ? 0 : 1;
        return;
      }
      console.log(parsed.stream === 'system' ? parsed.line : `  ${parsed.line}`);
    }
  }
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, arg] = positional;
  const need = (value: string | undefined, what: string): string => {
    if (!value) throw new CliError(`missing ${what}\n\n${USAGE}`);
    return value;
  };

  switch (command) {
    case 'status':
      return status();
    case 'history':
      return history(need(arg, 'slug'), typeof flags.limit === 'string' ? flags.limit : '20');
    case 'deploy': {
      const body = typeof flags.sha === 'string' ? { sha: flags.sha } : {};
      const r = await api<{ deploymentId: number; sha: string }>('POST', `/projects/${need(arg, 'slug')}/deploy`, body);
      console.log(`deployment #${r.deploymentId} queued (${r.sha.slice(0, 7)}) — catalyst logs ${r.deploymentId} --follow`);
      return;
    }
    case 'rollback': {
      const body = typeof flags.to === 'string' ? { deploymentId: Number(flags.to) } : {};
      const r = await api<{ deploymentId: number; sha: string; from: number }>(
        'POST',
        `/projects/${need(arg, 'slug')}/rollback`,
        body,
      );
      console.log(`rollback #${r.deploymentId} to ${r.sha.slice(0, 7)} (image of deployment #${r.from}) queued`);
      return;
    }
    case 'logs':
      return logs(need(arg, 'slug or id'), flags.follow === true || flags.f === true);
    case 'pause':
    case 'resume': {
      const r = await api<{ slug: string; paused: boolean }>('POST', `/projects/${need(arg, 'slug')}/${command}`, {});
      console.log(`${r.slug}: auto-deploy ${r.paused ? 'paused' : 'resumed'}`);
      return;
    }
    case 'cancel': {
      const r = await api<{ id: number; status: string }>('POST', `/deployments/${need(arg, 'id')}/cancel`, {});
      console.log(`deployment #${r.id}: ${r.status}`);
      return;
    }
    default:
      console.log(USAGE);
      if (command && command !== 'help') process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
