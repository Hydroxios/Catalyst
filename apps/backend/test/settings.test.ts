import { mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/context.js';
import { notifyDeployment, notifyText } from '../src/notify/discord.js';
import { DISCORD_WEBHOOK_RE, maskWebhook, SettingsStore } from '../src/settings.js';

const URL1 = 'https://discord.com/api/webhooks/123456789/abcDEF-ghi_jklMNOP';
const log = pino({ level: 'silent' });
const tmp = () => mkdtempSync(join(tmpdir(), 'catalyst-settings-'));

describe('réglages', () => {
  it('valeurs par défaut sans fichier', () => {
    expect(new SettingsStore(tmp(), log).get().discord).toEqual({
      webhookUrl: null,
      onSuccess: true,
      onFailure: true,
      onIncident: true,
    });
  });

  it('persiste et se relit depuis le disque', () => {
    const dir = tmp();
    new SettingsStore(dir, log).update({ discord: { webhookUrl: URL1, onSuccess: false } });
    const reloaded = new SettingsStore(dir, log).get().discord;
    expect(reloaded).toMatchObject({ webhookUrl: URL1, onSuccess: false, onFailure: true });
    if (process.platform !== 'win32') expect(statSync(join(dir, 'settings.json')).mode & 0o777).toBe(0o600);
  });

  it('voit un changement fait par un autre process', () => {
    const dir = tmp();
    const a = new SettingsStore(dir, log);
    const b = new SettingsStore(dir, log);
    a.update({ discord: { onIncident: false } });
    // Horodatage différent pour garantir la détection, même sur un système de fichiers grossier.
    const file = join(dir, 'settings.json');
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(b.get().discord.onIncident).toBe(false);
  });

  it('ignore un fichier corrompu', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'settings.json'), '{ pas du json');
    expect(new SettingsStore(dir, log).get().discord.webhookUrl).toBeNull();
  });

  it('valide et masque les URL de webhook', () => {
    expect(DISCORD_WEBHOOK_RE.test(URL1)).toBe(true);
    expect(DISCORD_WEBHOOK_RE.test('https://discordapp.com/api/webhooks/1/x')).toBe(true);
    expect(DISCORD_WEBHOOK_RE.test('https://evil.com/api/webhooks/1/x')).toBe(false);
    expect(DISCORD_WEBHOOK_RE.test('http://discord.com/api/webhooks/1/x')).toBe(false);
    expect(maskWebhook(URL1)).toBe('https://discord.com/api/webhooks/123456789/••••MNOP');
  });
});

describe('notifications Discord', () => {
  afterEach(() => vi.unstubAllGlobals());

  const ctxWith = (prefs: { onSuccess?: boolean; onFailure?: boolean; onIncident?: boolean }, envUrl?: string) => {
    const settings = new SettingsStore(tmp(), log);
    settings.update({ discord: { webhookUrl: envUrl ? null : URL1, ...prefs } });
    return { settings, env: { DISCORD_WEBHOOK_URL: envUrl }, log } as unknown as Ctx;
  };
  const notice = (ok: boolean) => ({ ok, slug: 'site', repo: 'a/b', sha: 'a'.repeat(40), commitMessage: 'feat', durationMs: 1000, url: 'http://x' });

  it('respecte les préférences succès / échec / incidents', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = ctxWith({ onSuccess: false });
    await notifyDeployment(ctx, notice(true));
    expect(fetchMock).not.toHaveBeenCalled();
    await notifyDeployment(ctx, notice(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(URL1);

    const quiet = ctxWith({ onIncident: false });
    await notifyText(quiet, 'disque plein');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('utilise DISCORD_WEBHOOK_URL si rien n’est réglé dans l’interface', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const envUrl = 'https://discord.com/api/webhooks/1/env';
    await notifyText(ctxWith({}, envUrl), 'incident');
    expect(fetchMock.mock.calls[0]![0]).toBe(envUrl);
  });
});
