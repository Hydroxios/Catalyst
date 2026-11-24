import { useMemo, useState } from 'react';
import { Badge, Button, ErrorBox, Spinner, StatusBadge } from '../components/ui';
import { api, isTerminal, type Activity, type DeploymentStatus, type Meta, type Project } from '../lib/api';
import { ago, shortSha, STATUS_LABEL, siteUrl } from '../lib/format';
import { useAction, usePoll, useTick } from '../lib/hooks';
import { href, navigate } from '../lib/router';
import { useCrumbs, useProjects } from '../lib/shell';
import { ProjectIcon } from '../components/ProjectIcon';
import { useToast } from '../lib/toast';
import { GithubMark, Logo } from './Login';
import { t } from '../i18n';

type Filter = 'all' | 'live' | 'building' | 'failed' | 'stopped' | 'paused';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'building', label: 'In progress' },
  { id: 'failed', label: 'Failed' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'paused', label: 'Auto-deploy paused' },
];

const WEEK_MS = 7 * 86400_000;

/** État affiché d'un projet : déploiement en cours > échec du dernier > en ligne > rien. */
function projectState(p: Project): { key: Filter | 'none'; status: DeploymentStatus | null } {
  const latest = p.latest ?? null;
  if (latest && !isTerminal(latest.status)) return { key: 'building', status: latest.status };
  if (p.stopped) return { key: 'stopped', status: null };
  if (latest?.status === 'failed') return { key: 'failed', status: 'failed' };
  if (p.live) return { key: 'live', status: 'live' };
  return { key: 'none', status: latest?.status ?? null };
}

export function Dashboard({ meta }: { meta: Meta }) {
  useCrumbs([{ label: t('Projects') }]);
  const projects = useProjects();
  const activity = usePoll(() => api<Activity[]>('GET', '/deployments?limit=12'), [], 5000);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  useTick();

  const list = projects.data ?? [];
  const stats = useMemo(() => {
    const since = Date.now() - WEEK_MS;
    let live = 0;
    let building = 0;
    let failures = 0;
    for (const p of list) {
      if (p.live && !p.stopped) live++;
      if (p.latest && !isTerminal(p.latest.status)) building++;
      failures += (p.recent ?? []).filter((r) => r.status === 'failed' && new Date(r.queued_at).getTime() > since).length;
    }
    return { total: list.length, live, building, failures };
  }, [list]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((p) => {
      if (q && !`${p.slug} ${p.repo} ${p.domains.join(' ')}`.toLowerCase().includes(q)) return false;
      if (filter === 'all') return true;
      if (filter === 'paused') return p.paused;
      return projectState(p).key === filter;
    });
  }, [list, query, filter]);

  if (projects.loading && !projects.data) return <Spinner />;
  if (projects.error && !projects.data) return <ErrorBox error={projects.error} onRetry={projects.reload} />;

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1>{t('Projects')}</h1>
        </div>
        <Button variant="primary" onClick={() => navigate('/new')}>
          {t('+ Import a repo')}
        </Button>
      </div>

      <section className="stats">
        <Stat label={t('Projects')} value={stats.total} />
        <Stat label={t('Live')} value={stats.live} total={stats.total} tone={stats.live > 0 ? 'ok' : undefined} />
        <Stat label={t('In progress')} value={stats.building} live={stats.building > 0} tone={stats.building > 0 ? 'progress' : undefined} />
        <Stat label={t('Failures · 7 days')} value={stats.failures} tone={stats.failures > 0 ? 'danger' : undefined} />
      </section>

      {list.length === 0 ? (
        <EmptyState meta={meta} />
      ) : (
        <div className="dash">
          <div className="dash-main">
            <div className="toolbar">
              <div className="search">
                <span className="search-icon" aria-hidden>
                  ⌕
                </span>
                <input
                  className="input"
                  placeholder={t('Search a project, repo, or domain…')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label={t('Search')}
                />
              </div>
              <div className="segmented" role="tablist" aria-label={t('Filter')}>
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    role="tab"
                    aria-selected={filter === f.id}
                    className={filter === f.id ? 'seg-active' : ''}
                    onClick={() => setFilter(f.id)}
                  >
                    {t(f.label)}
                  </button>
                ))}
              </div>
            </div>

            {visible.length === 0 ? (
              <div className="empty">
                <h3>{t('No matching project')}</h3>
                <button
                  className="link-button"
                  onClick={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                >
                  {t('Reset filters')}
                </button>
              </div>
            ) : (
              <div className="project-grid">
                {visible.map((p) => (
                  <ProjectCard key={p.slug} project={p} onChange={projects.reload} />
                ))}
              </div>
            )}
          </div>

          <aside className="dash-side">
            <ActivityFeed activity={activity.data} loading={activity.loading} />
          </aside>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  total,
  live,
  tone,
}: {
  label: string;
  value: number;
  total?: number;
  live?: boolean;
  tone?: 'ok' | 'progress' | 'danger';
}) {
  return (
    <div className={`stat glass${tone ? ` stat-${tone}` : ''}`}>
      <span className="stat-label">
        {live && <span className="ring" aria-hidden />}
        {label}
      </span>
      <span className="stat-value">
        {value}
        {total !== undefined && total > 0 && <span className="stat-total">/{total}</span>}
      </span>
    </div>
  );
}

function EmptyState({ meta }: { meta: Meta }) {
  return (
    <div className="hero glass">
      <div className="hero-mark" aria-hidden>
        <Logo className="hero-logo" />
      </div>
      <h2>{t('Your first deployment in a minute')}</h2>
      <p className="muted">
        {t('Import a GitHub repo: Catalyst detects the stack (or uses your Dockerfile), puts it online with HTTPS, and redeploys it on every push.')}
      </p>
      <ol className="hero-steps">
        <li className={meta.github.mode !== 'none' ? 'done' : ''}>{t('Connect GitHub')}</li>
        <li>{t('Import a repo')}</li>
        <li>{t('Push code')}</li>
      </ol>
      <div className="row gap-sm wrap">
        {meta.github.mode === 'none' ? (
          <a className="btn btn-primary" href={href('/settings')}>
            <GithubMark /> {t('Connect GitHub')}
          </a>
        ) : (
          <Button variant="primary" onClick={() => navigate('/new')}>
            {t('Import a repo')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Historique des derniers déploiements : une pastille par déploiement, du plus ancien au plus récent. */
function History({ recent, slug }: { recent: NonNullable<Project['recent']>; slug: string }) {
  const slots = [...Array<null>(Math.max(0, 12 - recent.length)).fill(null), ...recent];
  return (
    <div className="history" aria-label={t('History of {slug}', { slug })}>
      {slots.map((r, i) =>
        r ? (
          <a
            key={r.id}
            href={href(`/deployments/${r.id}`)}
            className={`pip pip-${r.status}`}
            title={`#${r.id} · ${STATUS_LABEL[r.status]} · ${ago(r.queued_at)}`}
          />
        ) : (
          <span key={`empty-${i}`} className="pip pip-empty" />
        ),
      )}
    </div>
  );
}

function ProjectCard({ project: p, onChange }: { project: Project; onChange: () => Promise<void> }) {
  const toast = useToast();
  const state = projectState(p);
  const latest = p.latest ?? null;
  const inProgress = state.key === 'building';
  const [deploy, deploying] = useAction(async () => {
    try {
      const r = await api<{ deploymentId: number }>('POST', `/projects/${p.slug}/deploy`, {});
      toast.success(t('Deployment started'), { label: t('View logs'), onClick: () => navigate(`/deployments/${r.deploymentId}`) });
      await onChange();
    } catch (err) {
      toast.error(err);
    }
  });

  return (
    <article className={`card glass project-card${inProgress ? ' is-building' : ''}`}>
      <a className="project-card-link" href={href(`/projects/${p.slug}`)} aria-label={t('Open {slug}', { slug: p.slug })} />

      <header className="pc-head">
        <ProjectIcon slug={p.slug} version={p.currentDeploymentId} className="monogram" />
        <div className="pc-title">
          <h2>{p.slug}</h2>
          <a className="pc-domain" href={siteUrl(p.domains[0]!)} target="_blank" rel="noreferrer">
            {p.domains[0]}
          </a>
        </div>
        <div className="pc-badges">
          {p.paused && (
            <Badge tone="warning" title={t('New commits are not deployed automatically')}>
              {t('auto-deploy paused')}
            </Badge>
          )}
          {!p.enabled && <Badge tone="muted">{t('removed')}</Badge>}
          {state.key === 'stopped' ? (
            <Badge tone="neutral">■ {t('stopped')}</Badge>
          ) : state.status ? (
            <StatusBadge status={state.status} />
          ) : (
            <Badge>{t('never deployed')}</Badge>
          )}
        </div>
      </header>

      <div className="pc-commit">
        {p.live ? (
          <>
            <span className="mono pc-sha">{shortSha(p.live.sha)}</span>
            <span className="truncate pc-msg">{p.live.commit_message ?? t('commit without a message')}</span>
            <span className="muted pc-when">{ago(p.live.went_live_at ?? p.live.finished_at)}</span>
          </>
        ) : (
          <span className="muted">{t('Not live yet')}</span>
        )}
      </div>

      {state.key === 'failed' && latest?.error && <p className="pc-error truncate">✕ {latest.error}</p>}

      <History recent={p.recent ?? []} slug={p.slug} />

      <footer className="pc-foot">
        <span className="pc-repo mono">
          <GithubMark /> {p.repo}
          <span className="muted">@{p.branch}</span>
        </span>
        <div className="row gap-sm">
          {p.live && !p.stopped && (
            <a className="btn btn-ghost btn-sm" href={siteUrl(p.domains[0]!)} target="_blank" rel="noreferrer">
              {t('Visit ↗')}
            </a>
          )}
          {inProgress ? (
            <Button size="sm" onClick={() => navigate(`/deployments/${latest!.id}`)}>
              {t('Follow')}
            </Button>
          ) : (
            <Button size="sm" busy={deploying} disabled={!p.enabled} onClick={() => void deploy()}>
              {t('Deploy')}
            </Button>
          )}
        </div>
      </footer>
    </article>
  );
}

function ActivityFeed({ activity, loading }: { activity: Activity[] | null; loading: boolean }) {
  return (
    <section className="feed glass">
      <h3 className="feed-title">{t('Activity')}</h3>
      {loading && !activity ? (
        <Spinner />
      ) : !activity || activity.length === 0 ? (
        <p className="muted small feed-empty">{t('Deployments will show up here.')}</p>
      ) : (
        <ol className="feed-list">
          {activity.map((a) => (
            <li key={a.id}>
              <a className="feed-item" href={href(`/deployments/${a.id}`)}>
                <span className={`feed-dot pip-${a.status}`} aria-hidden />
                <span className="feed-body">
                  <span className="feed-line">
                    <strong>{a.slug}</strong>
                    <span className="muted"> · {STATUS_LABEL[a.status].toLowerCase()}</span>
                  </span>
                  <span className="feed-msg truncate">
                    <span className="mono">{shortSha(a.sha)}</span> {a.commit_message ?? ''}
                  </span>
                </span>
                <span className="feed-when muted">{ago(a.queued_at)}</span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
