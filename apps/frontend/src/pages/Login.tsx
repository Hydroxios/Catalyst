import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../components/ui';
import { LanguageSwitcher } from '../i18n';
import { api, setToken, type Meta } from '../lib/api';
import { t } from '../i18n';

function hashParam(name: string): string | null {
  const query = window.location.hash.split('?')[1];
  return query ? new URLSearchParams(query).get(name) : null;
}

export function Login() {
  const [config, setConfig] = useState<{ github: boolean; appName: string | null } | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [token, setValue] = useState('');
  const [error, setError] = useState<string | null>(hashParam('auth_error'));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ github: boolean; appName: string | null }>('GET', '/auth/config', undefined, null, true).then(
      (c) => {
        setConfig(c);
        if (!c.github) setShowToken(true);
      },
      () => setShowToken(true),
    );
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<Meta>('GET', '/meta', undefined, token.trim());
      setToken(token.trim());
      window.location.hash = '/';
    } catch (err) {
      setError((err as { status?: number }).status === 401 ? t('Invalid token.') : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="backdrop" aria-hidden />
      <LanguageSwitcher className="login-lang" />
      <div className="glass login-card">
        <div className="brand brand-lg">
          <Logo /> Catalyst
        </div>
        <p className="login-tagline">{t('Push. Build. Live.')}</p>

        {config?.github && (
          <a className="btn btn-primary btn-lg btn-block" href="/auth/github/login">
            <GithubMark /> {t('Continue with GitHub')}
          </a>
        )}
        {config && !config.github && (
          <p className="muted small">
            {t('First sign-in: use the admin token, then connect GitHub from Settings to enable GitHub sign-in and repo import.')}
          </p>
        )}

        {error && <div className="alert alert-danger">{error}</div>}

        {config?.github && !showToken && (
          <button type="button" className="link-button" onClick={() => setShowToken(true)}>
            {t('Use the admin token')}
          </button>
        )}
        {showToken && (
          <form className="stack-sm" onSubmit={submit}>
            <input
              className="input mono"
              type="password"
              value={token}
              onChange={(e) => setValue(e.target.value)}
              placeholder="ADMIN_TOKEN"
              autoFocus={!config?.github}
              required
              autoComplete="current-password"
              aria-label={t('Admin token')}
            />
            <Button type="submit" variant={config?.github ? 'secondary' : 'primary'} busy={busy}>
              {t('Sign in with the token')}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Logo « orbite » : un C ouvert d'où part un point (le lancement). Suit la couleur du texte. */
export function Logo({ className = 'logo' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden>
      <path d="M23.66 9.57A10 10 0 1 0 23.66 22.43" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      <circle cx="26.6" cy="16" r="2.7" fill="currentColor" />
    </svg>
  );
}

export function GithubMark() {
  return (
    <svg className="gh-mark" viewBox="0 0 16 16" aria-hidden>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}
