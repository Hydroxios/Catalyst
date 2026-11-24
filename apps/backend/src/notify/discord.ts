import type { Ctx } from '../context.js';

export interface DeploymentNotice {
  ok: boolean;
  slug: string;
  repo: string;
  sha: string;
  commitMessage: string | null;
  durationMs: number;
  url: string;
  error?: string | null;
  rollback?: boolean;
}

/** URL de webhook active : celle des Réglages, sinon DISCORD_WEBHOOK_URL (.env). */
export function discordWebhookUrl(ctx: Ctx): string | null {
  return ctx.settings.get().discord.webhookUrl ?? ctx.env.DISCORD_WEBHOOK_URL ?? null;
}

export async function postDiscord(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `Discord responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` };
  } catch (err) {
    return { ok: false, error: `Discord unreachable: ${(err as Error).message}` };
  }
}

async function post(ctx: Ctx, body: unknown): Promise<void> {
  const url = discordWebhookUrl(ctx);
  if (!url) return;
  const result = await postDiscord(url, body);
  if (!result.ok) ctx.log.warn({ error: result.error }, 'Discord notification not sent');
}

export function deploymentEmbed(n: DeploymentNotice) {
  const short = n.sha.slice(0, 7);
  const seconds = Math.round(n.durationMs / 1000);
  const fields = [
    { name: 'Commit', value: `[\`${short}\`](https://github.com/${n.repo}/commit/${n.sha})`, inline: true },
    { name: 'Duration', value: `${seconds} s`, inline: true },
  ];
  if (n.commitMessage) fields.push({ name: 'Message', value: n.commitMessage.slice(0, 1000), inline: false });
  if (!n.ok && n.error) fields.push({ name: 'Error', value: n.error.slice(0, 1000), inline: false });
  return {
    embeds: [
      {
        title: `${n.ok ? '✅' : '❌'} ${n.slug}${n.rollback ? ' (rollback)' : ''}`,
        url: n.url,
        color: n.ok ? 0x22c55e : 0xef4444,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/** Message de fin de déploiement (plan §14.3), selon les préférences des Réglages. */
export async function notifyDeployment(ctx: Ctx, n: DeploymentNotice): Promise<void> {
  const prefs = ctx.settings.get().discord;
  if (n.ok ? !prefs.onSuccess : !prefs.onFailure) return;
  await post(ctx, deploymentEmbed(n));
}

/** Incident de la plateforme (site relancé, disque plein…). */
export async function notifyText(ctx: Ctx, text: string): Promise<void> {
  if (!ctx.settings.get().discord.onIncident) return;
  await post(ctx, { content: text.slice(0, 2000) });
}
