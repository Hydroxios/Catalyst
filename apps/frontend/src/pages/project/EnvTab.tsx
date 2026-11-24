import { useEffect, useState } from 'react';
import { KeyValueEditor } from '../../components/KeyValueEditor';
import { Button, Card, ErrorBox, Spinner } from '../../components/ui';
import { api, type EnvVar, type Project } from '../../lib/api';
import { usePoll } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { t } from '../../i18n';

/** Variables d'environnement runtime du projet (fichier <slug>.env côté serveur). */
export function EnvTab({ project, onRedeploy }: { project: Project; onRedeploy: () => void }) {
  const toast = useToast();
  const env = usePoll(() => api<{ vars: EnvVar[] }>('GET', `/projects/${project.slug}/env`), [project.slug]);
  const [rows, setRows] = useState<EnvVar[]>([]);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState(false);
  const [pasteText, setPasteText] = useState('');

  useEffect(() => {
    if (env.data) setRows(env.data.vars);
  }, [env.data]);

  if (env.loading && !env.data) return <Spinner />;
  if (env.error && !env.data) return <ErrorBox error={env.error} onRetry={env.reload} />;

  const dirty = JSON.stringify(rows) !== JSON.stringify(env.data?.vars ?? []);

  const save = async () => {
    const clean = rows.filter((r) => r.key.trim());
    setBusy(true);
    try {
      await api('PUT', `/projects/${project.slug}/env`, { vars: clean });
      await env.reload();
      toast.success(t('Variables saved — they apply on the next deployment'), {
        label: t('Redeploy'),
        onClick: onRedeploy,
      });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const importPaste = () => {
    const parsed: EnvVar[] = [];
    for (const raw of pasteText.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(raw);
      if (!m || raw.trim().startsWith('#')) continue;
      parsed.push({ key: m[1]!, value: m[2]!.replace(/^(['"])(.*)\1$/, '$2') });
    }
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const p of parsed) byKey.set(p.key, p);
    setRows([...byKey.values()]);
    setPaste(false);
    setPasteText('');
    toast.success(t('{n} variable(s) imported — remember to save', { n: parsed.length }));
  };

  return (
    <Card>
      <div className="card-head">
        <div>
          <h2>{t('Environment variables')}</h2>
          <p className="muted small">
            {t('Injected into the container at start. Stored on the server (file with')} <span className="mono">chmod 600</span>
            {t('), never in the repo or the logs.')}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setPaste((p) => !p)}>
          {t('Paste a .env')}
        </Button>
      </div>
      {paste && (
        <div className="stack-sm paste-box">
          <textarea
            className="input mono"
            rows={6}
            placeholder={'DATABASE_URL=postgres://...\nAPI_KEY=...'}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            spellCheck={false}
          />
          <div className="row gap-sm">
            <Button size="sm" onClick={importPaste} disabled={!pasteText.trim()}>
              {t('Import')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPaste(false)}>
              {t('Close')}
            </Button>
          </div>
        </div>
      )}
      <KeyValueEditor rows={rows} onChange={setRows} secret keyPlaceholder="VARIABLE_NAME" />
      <div className="form-actions">
        {dirty && (
          <Button variant="ghost" onClick={() => setRows(env.data?.vars ?? [])}>
            {t('Discard changes')}
          </Button>
        )}
        <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => void save()}>
          {t('Save')}
        </Button>
      </div>
    </Card>
  );
}
