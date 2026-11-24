import { useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Spinner } from '../components/ui';
import { api, type Settings } from '../lib/api';
import { usePoll } from '../lib/hooks';
import { useCrumbs } from '../lib/shell';
import { useToast } from '../lib/toast';
import { GithubMark } from './Login';
import { NotificationsCard } from './NotificationsCard';
import { t } from '../i18n';

function hashParam(name: string): string | null {
  const query = window.location.hash.split('?')[1];
  return query ? new URLSearchParams(query).get(name) : null;
}

/** Soumet le manifest à github.com : GitHub crée l'App puis revient sur /auth/github/app-created. */
async function createGithubApp(org: string): Promise<void> {
  const { action, manifest } = await api<{ action: string; manifest: unknown }>('POST', '/github/app/manifest', {
    org: org || undefined,
  });
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = JSON.stringify(manifest);
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

export function SettingsPage({ onChange }: { onChange: () => Promise<void> }) {
  const toast = useToast();
  useCrumbs([{ label: t('Settings') }]);
  const settings = usePoll(() => api<Settings>('GET', '/settings'), []);
  const [org, setOrg] = useState('');
  const [useOrg, setUseOrg] = useState(false);
  const [creating, setCreating] = useState(false);
  const [admins, setAdmins] = useState('');
  const [savingAdmins, setSavingAdmins] = useState(false);
  const error = hashParam('error');

  useEffect(() => {
    if (settings.data) setAdmins(settings.data.admins.join('\n'));
  }, [settings.data]);

  if (settings.loading && !settings.data) return <Spinner />;
  if (settings.error && !settings.data) return <ErrorBox error={settings.error} onRetry={settings.reload} />;
  const s = settings.data!;
  const app = s.github.app;

  const create = async () => {
    setCreating(true);
    try {
      await createGithubApp(useOrg ? org.trim() : '');
    } catch (err) {
      toast.error(err);
      setCreating(false);
    }
  };

  const saveAdmins = async () => {
    setSavingAdmins(true);
    try {
      const list = admins.split(/[\s,]+/).map((a) => a.replace(/^@/, '')).filter(Boolean);
      await api('PUT', '/settings/admins', { admins: list });
      await settings.reload();
      await onChange();
      toast.success(t('Admins saved'));
    } catch (err) {
      toast.error(err);
    } finally {
      setSavingAdmins(false);
    }
  };

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <div>
          <h1>{t('Settings')}</h1>
        </div>
      </div>
      {error && <div className="alert alert-danger">{error}</div>}

      <Card>
        <div className="card-head">
          <div>
            <h2 className="row gap-sm">
              <GithubMark /> GitHub
            </h2>
            <p className="muted small">
              {t('Sign-in, repo import, and deploy on every push, through a private GitHub App.')}
            </p>
          </div>
          {app ? <Badge tone="success">{t('connected')}</Badge> : s.github.mode === 'token' ? <Badge>{t('personal token')}</Badge> : <Badge tone="muted">{t('not set up')}</Badge>}
        </div>

        {app ? (
          <div className="stack">
            <dl className="kv-list">
              <div>
                <dt>App</dt>
                <dd>
                  {app.htmlUrl ? (
                    <a href={app.htmlUrl} target="_blank" rel="noreferrer">
                      {app.name} ↗
                    </a>
                  ) : (
                    app.name
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('Owner')}</dt>
                <dd className="mono">{app.owner || '—'}</dd>
              </div>
            </dl>
            <div className="row gap-sm wrap">
              {s.github.installUrl && (
                <a className="btn btn-primary" href={s.github.installUrl}>
                  {t('Choose accessible repos ↗')}
                </a>
              )}
              {app.htmlUrl && (
                <a className="btn" href={app.htmlUrl.replace('/apps/', '/settings/apps/')} target="_blank" rel="noreferrer">
                  {t('App settings ↗')}
                </a>
              )}
            </div>
          </div>
        ) : (
          <div className="stack">
            <ol className="steps-list">
              <li>{t('Catalyst prepares a private GitHub App (permissions: read code, commit statuses; event: push).')}</li>
              <li>{t('GitHub asks you to confirm its creation.')}</li>
              <li>{t("You choose which repos Catalyst can access. That's it: no key to copy, no webhook to set up.")}</li>
            </ol>
            <label className="check">
              <input type="checkbox" checked={useOrg} onChange={(e) => setUseOrg(e.target.checked)} />
              <span>{t('Create the App in an organization')}</span>
            </label>
            {useOrg && (
              <Field label={t('GitHub organization')}>
                <input className="input mono" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="my-org" />
              </Field>
            )}
            <div>
              <Button variant="primary" busy={creating} disabled={useOrg && !org.trim()} onClick={() => void create()}>
                <GithubMark /> {t('Connect GitHub')}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <NotificationsCard />

      <Card>
        <div className="card-head">
          <div>
            <h2>{t('Access')}</h2>
            <p className="muted small">
              {t('GitHub accounts allowed to sign in. Catalyst controls Docker on the server: only add people you trust.')}
            </p>
          </div>
        </div>
        <Field label={t('GitHub logins')} hint={t('One per line')}>
          <textarea
            className="input mono"
            rows={Math.max(3, admins.split('\n').length + 1)}
            value={admins}
            onChange={(e) => setAdmins(e.target.value)}
            disabled={!app}
            placeholder={app ? 'octocat' : t('Available once GitHub is connected')}
            spellCheck={false}
          />
        </Field>
        {s.envAdmins.length > 0 && (
          <p className="muted small">
            {t('Also allowed through')} <span className="mono">CATALYST_ADMINS</span>: {s.envAdmins.join(', ')}
          </p>
        )}
        <div className="form-actions">
          <Button variant="primary" busy={savingAdmins} disabled={!app} onClick={() => void saveAdmins()}>
            {t('Save')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
