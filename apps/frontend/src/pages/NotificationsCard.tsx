import { useEffect, useState, type FormEvent } from 'react';
import { useDialog } from '../components/Modal';
import { Badge, Button, Card, ErrorBox, Field, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { usePoll } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { t } from '../i18n';

interface DiscordView {
  configured: boolean;
  webhookMasked: string | null;
  fromEnv: boolean;
  onSuccess: boolean;
  onFailure: boolean;
  onIncident: boolean;
}

const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

const EVENTS = [
  { key: 'onSuccess', label: 'Deployment succeeded', hint: 'The site is live with the new version.' },
  { key: 'onFailure', label: 'Deployment failed', hint: 'Build, start, or healthcheck failed (the live version stays in place).' },
  { key: 'onIncident', label: 'Incidents', hint: 'Site restarted after an unexpected stop, missing image, disk almost full.' },
] as const;

/** Réglages des notifications Discord (Réglages → Notifications). */
export function NotificationsCard() {
  const toast = useToast();
  const dialog = useDialog();
  const view = usePoll(() => api<{ discord: DiscordView }>('GET', '/settings/notifications'), []);
  const [url, setUrl] = useState('');
  const [prefs, setPrefs] = useState({ onSuccess: true, onFailure: true, onIncident: true });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const d = view.data?.discord;
  useEffect(() => {
    if (d) setPrefs({ onSuccess: d.onSuccess, onFailure: d.onFailure, onIncident: d.onIncident });
  }, [d?.onSuccess, d?.onFailure, d?.onIncident]); // eslint-disable-line react-hooks/exhaustive-deps

  if (view.loading && !view.data) return <Spinner />;
  if (view.error && !view.data) return <ErrorBox error={view.error} onRetry={view.reload} />;

  const urlValid = url.trim() === '' || WEBHOOK_RE.test(url.trim());
  const prefsChanged = !!d && (prefs.onSuccess !== d.onSuccess || prefs.onFailure !== d.onFailure || prefs.onIncident !== d.onIncident);
  const dirty = url.trim() !== '' || prefsChanged;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!urlValid) return;
    setSaving(true);
    try {
      await api('PUT', '/settings/notifications', {
        discord: { ...prefs, ...(url.trim() ? { webhookUrl: url.trim() } : {}) },
      });
      setUrl('');
      await view.reload();
      toast.success(t('Notifications saved'));
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await api('POST', '/settings/notifications/test', {});
      toast.success(t('Test message sent: check your Discord channel'));
    } catch (err) {
      toast.error(err);
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    const ok = await dialog.confirm({
      title: t('Remove the Discord webhook?'),
      message: d?.fromEnv
        ? t('The webhook comes from DISCORD_WEBHOOK_URL (.env): remove the variable from the file, then restart Catalyst.')
        : t('No more notifications will be sent to Discord.'),
      confirmLabel: t('Remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api('PUT', '/settings/notifications', { discord: { webhookUrl: null } });
      await view.reload();
      toast.success(t('Webhook removed'));
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <Card>
      <div className="card-head">
        <div>
          <h2>Notifications</h2>
          <p className="muted small">{t('A message in a Discord channel when deployments finish and when incidents happen.')}</p>
        </div>
        {d?.configured ? <Badge tone="success">● {t('Discord connected')}</Badge> : <Badge tone="muted">{t('disabled')}</Badge>}
      </div>

      <form className="stack" onSubmit={save}>
        <Field
          label={t('Discord webhook')}
          hint={
            d?.configured ? (
              <>
                {t('Current:')} <span className="mono">{d.webhookMasked}</span>
                {d.fromEnv && t(' (set by DISCORD_WEBHOOK_URL in .env)')} — {t('paste a new URL to replace it.')}
              </>
            ) : (
              t('Discord: Channel settings → Integrations → Webhooks → New webhook → Copy webhook URL.')
            )
          }
          error={urlValid ? undefined : t('Expected URL: https://discord.com/api/webhooks/…')}
        >
          <input
            className="input mono"
            type="password"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={d?.configured ? t('New URL (leave empty to keep the current one)') : 'https://discord.com/api/webhooks/…'}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <fieldset className="notify-events">
          <legend className="field-label">{t('Send a message for')}</legend>
          {EVENTS.map((ev) => (
            <label key={ev.key} className="check">
              <input
                type="checkbox"
                checked={prefs[ev.key]}
                onChange={(e) => setPrefs((p) => ({ ...p, [ev.key]: e.target.checked }))}
              />
              <span>
                {t(ev.label)}
                <span className="muted small notify-hint">{t(ev.hint)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="form-actions notify-actions">
          {d?.configured && (
            <>
              <Button type="button" variant="ghost" onClick={() => void remove()}>
                {t('Remove')}
              </Button>
              <Button type="button" busy={testing} onClick={() => void test()}>
                {t('Send a test')}
              </Button>
            </>
          )}
          <Button type="submit" variant="primary" busy={saving} disabled={!dirty || !urlValid}>
            {t('Save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
