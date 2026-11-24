import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/config/env.js';
import { appManifest } from '../src/auth/routes.js';
import type { Ctx } from '../src/context.js';
import { GitHubService, type AppCredentials } from '../src/github/service.js';

function service(env: Partial<Env> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'catalyst-'));
  return new GitHubService({ DATA_DIR: dataDir, ...env } as Env, pino({ level: 'silent' }));
}

describe('GitHubService', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const creds: AppCredentials = {
    id: 1234,
    slug: 'catalyst-test',
    name: 'Catalyst test',
    htmlUrl: 'https://github.com/apps/catalyst-test',
    owner: 'killian',
    clientId: 'Iv1.x',
    clientSecret: 's',
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    webhookSecret: 'secret-webhook-app-xxxxxx',
    admins: ['Killian'],
  };

  it('signe un JWT RS256 valide pour l’App', () => {
    const gh = service();
    gh.saveApp(creds);
    const jwt = (gh as unknown as { appJwt(): string }).appJwt();
    const [header, payload, signature] = jwt.split('.');
    const ok = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(ok).toBe(true);
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims.iss).toBe('1234');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it('persiste la config et la relit au démarrage', () => {
    const gh = service();
    gh.saveApp(creds);
    const reloaded = new GitHubService(
      { DATA_DIR: (gh as unknown as { env: Env }).env.DATA_DIR } as Env,
      pino({ level: 'silent' }),
    );
    expect(reloaded.mode).toBe('app');
    expect(reloaded.installUrl()).toBe('https://github.com/apps/catalyst-test/installations/new');
  });

  it('gère la liste des admins (insensible à la casse, env + réglages)', () => {
    const gh = service({ CATALYST_ADMINS: 'alice, Bob' });
    expect(gh.isAdmin('killian')).toBe(false);
    gh.saveApp(creds);
    expect(gh.isAdmin('KILLIAN')).toBe(true);
    expect(gh.isAdmin('bob')).toBe(true);
    expect(gh.isAdmin('mallory')).toBe(false);
  });

  it('accepte les secrets de webhook de l’App et de l’env', () => {
    const gh = service({ GITHUB_WEBHOOK_SECRET: 'secret-env-xxxxxxxxxx' });
    expect(gh.webhookSecrets()).toEqual(['secret-env-xxxxxxxxxx']);
    gh.saveApp(creds);
    expect(gh.webhookSecrets()).toEqual(['secret-webhook-app-xxxxxx', 'secret-env-xxxxxxxxxx']);
  });

  it('refuse l’accès à un repo sans App ni token', async () => {
    await expect(service().forRepo('a/b')).rejects.toThrow('no GitHub access configured');
  });
});

describe('manifest de la GitHub App', () => {
  const ctxFor = (env: Partial<Env>) => ({ env: { ...env } }) as unknown as Ctx;

  it('déclare le webhook quand Catalyst est public', () => {
    const m = appManifest(ctxFor({ PUBLIC_URL: 'https://deploy.mondomaine.fr' }));
    expect(m.hook_attributes?.url).toBe('https://deploy.mondomaine.fr/webhooks/github');
    expect(m.default_events).toEqual(['push']);
  });

  it('en local, pas de webhook (GitHub refuse localhost) : polling', () => {
    const m = appManifest(ctxFor({ PUBLIC_URL: 'http://catalyst.localhost' }));
    expect(m.hook_attributes).toBeUndefined();
    expect(m.default_events).toEqual([]);
    expect(m.callback_urls).toEqual(['http://catalyst.localhost/auth/github/callback']);
  });

  it('en local avec un relais smee, le webhook passe par le relais', () => {
    const m = appManifest(
      ctxFor({ PUBLIC_URL: 'http://catalyst.localhost', GITHUB_WEBHOOK_URL: 'https://smee.io/abc' }),
    );
    expect(m.hook_attributes?.url).toBe('https://smee.io/abc');
  });
});
