import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';

/**
 * Réglages modifiables depuis l'interface, stockés dans DATA_DIR/settings.json (chmod 600).
 * Relu automatiquement quand le fichier change : un process API et un process worker séparés
 * voient toujours la même valeur.
 */

/** URL de webhook Discord (y compris discordapp.com et les variantes canary/ptb). */
export const DISCORD_WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

const settingsSchema = z.object({
  discord: z
    .object({
      webhookUrl: z.string().regex(DISCORD_WEBHOOK_RE).nullable().default(null),
      onSuccess: z.boolean().default(true),
      onFailure: z.boolean().default(true),
      onIncident: z.boolean().default(true),
    })
    .default({}),
});

export type Settings = z.infer<typeof settingsSchema>;
export type DiscordSettings = Settings['discord'];

export class SettingsStore {
  private cache: Settings;
  private mtime = 0;
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly log: Logger,
  ) {
    this.file = join(dataDir, 'settings.json');
    this.cache = settingsSchema.parse({});
    this.reload();
  }

  private reload(): void {
    let mtime: number;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      return; // pas encore de fichier : valeurs par défaut
    }
    if (mtime === this.mtime) return;
    try {
      this.cache = settingsSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      this.mtime = mtime;
    } catch (err) {
      this.log.error({ err, file: this.file }, 'unreadable settings, using defaults');
    }
  }

  get(): Settings {
    this.reload();
    return this.cache;
  }

  update(patch: { discord?: Partial<DiscordSettings> }): Settings {
    const current = this.get();
    const next = settingsSchema.parse({ ...current, discord: { ...current.discord, ...patch.discord } });
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    this.cache = next;
    this.mtime = statSync(this.file).mtimeMs;
    return next;
  }
}

/** « https://discord.com/api/webhooks/123/abcd…wxyz » → fin masquée, pour l'affichage. */
export function maskWebhook(url: string): string {
  const m = /^(https:\/\/[^/]+\/api\/webhooks\/\d+\/)([\w-]+)$/.exec(url);
  if (!m) return '••••';
  return `${m[1]}••••${m[2]!.slice(-4)}`;
}
