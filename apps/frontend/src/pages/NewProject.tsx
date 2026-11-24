import { useMemo, useState } from 'react';
import { ProjectForm } from '../components/ProjectForm';
import { Badge, Button, Card, Empty, ErrorBox, Spinner } from '../components/ui';
import { api, type Meta, type ProjectConfig, type ProjectInput, type Repo, type RepoInspection } from '../lib/api';
import { ago, slugify } from '../lib/format';
import { usePoll } from '../lib/hooks';
import { href, navigate } from '../lib/router';
import { useCrumbs, useProjects } from '../lib/shell';
import { useToast } from '../lib/toast';
import { GithubMark } from './Login';
import { t } from '../i18n';

interface Imported {
  defaults: Partial<ProjectConfig>;
  inspection: RepoInspection;
}

export function NewProject({ meta }: { meta: Meta }) {
  const toast = useToast();
  const projects = useProjects();
  useCrumbs([{ label: t('Projects'), href: href('/') }, { label: t('Import a repo') }]);
  const [imported, setImported] = useState<Imported | null>(null);
  const [manual, setManual] = useState(meta.github.mode === 'none');

  const create = async (input: ProjectInput, opts: { deployNow: boolean; setupWebhook: boolean }) => {
    await api('POST', '/projects', input);
    toast.success(t('Project {slug} created', { slug: input.slug }));
    void projects.reload();

    if (opts.setupWebhook) {
      try {
        await api('POST', `/projects/${input.slug}/webhook`);
        toast.success(t('GitHub webhook set up'));
      } catch (err) {
        toast.show('error', t('Webhook not set up: {error}. Polling will take over.', { error: (err as Error).message }));
      }
    }

    if (opts.deployNow) {
      try {
        const r = await api<{ deploymentId: number }>('POST', `/projects/${input.slug}/deploy`, {});
        navigate(`/deployments/${r.deploymentId}`);
        return;
      } catch (err) {
        toast.error(err);
      }
    }
    navigate(`/projects/${input.slug}`);
  };

  return (
    <div className="page page-narrow">
      <div>
        <h1>{imported ? t('Set up {repo}', { repo: imported.defaults.repo ?? '' }) : t('Import a repo')}</h1>
      </div>

      {imported ? (
        <>
          <DetectionSummary inspection={imported.inspection} branch={imported.defaults.branch ?? ''} />
          <Card>
            <ProjectForm
              mode="create"
              meta={meta}
              defaults={imported.defaults}
              lockRepo
              detectedBuild={imported.inspection.detected?.build}
              detectedStart={imported.inspection.detected?.start}
              onSubmit={create}
            />
          </Card>
          <div>
            <Button variant="ghost" onClick={() => setImported(null)}>
              {t('← Pick another repo')}
            </Button>
          </div>
        </>
      ) : manual ? (
        <>
          {meta.github.mode === 'none' && (
            <div className="alert alert-info">
              <span>{t('Connect GitHub to import your repos in one click.')}</span>
              <a className="btn btn-sm" href={href('/settings')}>
                {t('Connect GitHub')}
              </a>
            </div>
          )}
          <Card>
            <ProjectForm mode="create" meta={meta} onSubmit={create} />
          </Card>
          {meta.github.mode !== 'none' && (
            <div>
              <Button variant="ghost" onClick={() => setManual(false)}>
                {t('← Back to the repo list')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <RepoPicker meta={meta} onPick={setImported} onManual={() => setManual(true)} />
      )}
    </div>
  );
}

function RepoPicker({
  meta,
  onPick,
  onManual,
}: {
  meta: Meta;
  onPick: (i: Imported) => void;
  onManual: () => void;
}) {
  const toast = useToast();
  const repos = usePoll(() => api<Repo[]>('GET', '/github/repos'), []);
  const projects = usePoll(() => api<{ repo: string; branch: string }[]>('GET', '/projects'), []);
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState<string | null>(null);
  const justInstalled = window.location.hash.includes('installed=1');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos.data ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q));
  }, [repos.data, query]);

  const pick = async (r: Repo) => {
    setPicking(r.fullName);
    try {
      const info = await api<RepoInspection>(
        'GET',
        `/github/repos/${r.fullName}/inspect?ref=${encodeURIComponent(r.defaultBranch)}`,
      ).catch((err: Error): RepoInspection => ({ dockerfile: false, port: null, detected: null, error: err.message }));
      onPick({
        inspection: info,
        defaults: {
          repo: r.fullName,
          branch: r.defaultBranch,
          slug: slugify(r.fullName.split('/')[1] ?? ''),
          ...(info.port ? { port: info.port } : {}),
        },
      });
    } catch (err) {
      toast.error(err);
    } finally {
      setPicking(null);
    }
  };

  const deployed = new Set((projects.data ?? []).map((p) => p.repo.toLowerCase()));

  return (
    <Card className="card-flush">
      <div className="picker-head">
        <input
          className="input"
          placeholder={t('Search a repo…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          aria-label={t('Search a repo')}
        />
        {meta.github.installUrl && (
          <a className="btn" href={meta.github.installUrl} title={t('Give access to more repos')}>
            <GithubMark /> {t('Add repos')}
          </a>
        )}
      </div>

      {justInstalled && <div className="alert alert-info picker-alert">{t('Access updated on GitHub. Pick the repo to deploy.')}</div>}

      {repos.loading && !repos.data ? (
        <Spinner label={t('Loading repos…')} />
      ) : repos.error && !repos.data ? (
        <div className="picker-pad">
          <ErrorBox error={repos.error} onRetry={repos.reload} />
        </div>
      ) : filtered.length === 0 ? (
        <Empty title={query ? t('No matching repo') : t('No accessible repo')}>
          {meta.github.installUrl && (
            <p className="muted">
              {t('Give access to your repos from the')}{' '}
              <a href={meta.github.installUrl}>{t('GitHub App installation')}</a>.
            </p>
          )}
        </Empty>
      ) : (
        <ul className="repo-list">
          {filtered.slice(0, 100).map((r) => (
            <li key={r.fullName} className="repo-item">
              <div className="repo-main">
                <div className="row gap-sm wrap">
                  <span className="repo-name">{r.fullName}</span>
                  {r.private && <Badge tone="muted">{t('private')}</Badge>}
                  {deployed.has(r.fullName.toLowerCase()) && <Badge>{t('already deployed')}</Badge>}
                </div>
                <div className="muted small truncate">
                  {r.description ?? r.defaultBranch}
                  {r.pushedAt && <> · {ago(r.pushedAt)}</>}
                </div>
              </div>
              <Button size="sm" variant="primary" busy={picking === r.fullName} onClick={() => void pick(r)}>
                {t('Import')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="picker-foot">
        <button type="button" className="link-button" onClick={onManual}>
          {t('Enter a repo manually')}
        </button>
      </div>
    </Card>
  );
}

/** Ce que Catalyst va construire : Dockerfile du repo, ou stack détectée. */
function DetectionSummary({ inspection, branch }: { inspection: RepoInspection; branch: string }) {
  if (inspection.dockerfile) {
    return (
      <div className="detect glass">
        <span className="detect-icon">◧</span>
        <div>
          <strong>{t("Repo's Dockerfile")}</strong>
          <p className="muted small">
            {t('Built with the Dockerfile from branch {branch}', { branch })}
            {inspection.port ? ` · port ${inspection.port} (EXPOSE)` : ''}.
          </p>
        </div>
      </div>
    );
  }
  if (inspection.detected) {
    const d = inspection.detected;
    return (
      <div className="detect glass">
        <span className="detect-icon">✦</span>
        <div className="detect-body">
          <strong>{t('Detected: {label}', { label: d.label })}</strong>
          <p className="muted small">{t('No Dockerfile: Catalyst generates one for this stack.')}</p>
          <dl className="detect-cmds">
            {d.build && (
              <div>
                <dt>Build</dt>
                <dd className="mono">{d.build}</dd>
              </div>
            )}
            {d.start && (
              <div>
                <dt>{t('Start')}</dt>
                <dd className="mono">{d.start}</dd>
              </div>
            )}
            {!d.start && (
              <div>
                <dt>Service</dt>
                <dd>{t('static files (nginx)')}</dd>
              </div>
            )}
          </dl>
          {d.notes.map((n) => (
            <p key={n} className="small muted">
              ⚠ {n}
            </p>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="alert alert-warning">
      <span>
        {inspection.error ?? t('Stack not recognized.')} {t('You can set the build and start commands under "Build, start, healthcheck, and resources".')}
      </span>
    </div>
  );
}
