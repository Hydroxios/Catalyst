import { useMemo, useState } from 'react';
import { isTerminal, logout, type Meta, type Project, type User } from '../lib/api';
import { href } from '../lib/router';
import { useProjects } from '../lib/shell';
import { GithubMark, Logo } from '../pages/Login';
import { ProjectIcon } from './ProjectIcon';
import { IconGrid, IconLogout, IconPlus, IconPulse, IconSearch, IconSettings, IconSidebar } from './icons';
import { t } from '../i18n';

/** Pastille d'état d'un projet dans la liste (monochrome, comme l'historique). */
function dotClass(p: Project): string {
  const latest = p.latest ?? null;
  if (p.stopped) return 'pip-stopped';
  if (latest && !isTerminal(latest.status)) return 'pip-building';
  if (latest?.status === 'failed') return 'pip-failed';
  if (p.live) return 'pip-live';
  return 'pip-empty';
}

export function Sidebar({
  user,
  meta,
  path,
  collapsed,
  onToggleCollapsed,
  onNavigate,
}: {
  user: User;
  meta: Meta | null;
  path: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Ferme le tiroir sur mobile après un clic. */
  onNavigate: () => void;
}) {
  const projects = useProjects();
  const [filter, setFilter] = useState('');
  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (projects.data ?? []).filter((p) => !q || p.slug.includes(q) || p.repo.toLowerCase().includes(q));
  }, [projects.data, filter]);

  const section = path.startsWith('/settings')
    ? 'settings'
    : path.startsWith('/activity')
      ? 'activity'
      : path === '/new'
        ? 'new'
        : 'projects';
  const currentSlug = /^\/projects\/([^/?]+)/.exec(path)?.[1];

  const nav = [
    { id: 'projects', label: t('Projects'), to: '/', icon: <IconGrid /> },
    { id: 'activity', label: t('Activity'), to: '/activity', icon: <IconPulse /> },
    { id: 'settings', label: t('Settings'), to: '/settings', icon: <IconSettings /> },
  ];

  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="Navigation">
      <div className="sb-head">
        <a className="brand" href={href('/')} onClick={onNavigate} title="Catalyst">
          <Logo />
          <span className="sb-text">Catalyst</span>
        </a>
        <button
          type="button"
          className="sb-icon-btn sb-collapse"
          onClick={onToggleCollapsed}
          title={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
          aria-label={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
        >
          <IconSidebar />
        </button>
      </div>

      <a
        className={`btn btn-primary sb-cta${section === 'new' ? ' is-active' : ''}`}
        href={href('/new')}
        onClick={onNavigate}
        title={t('Import a repo')}
      >
        <IconPlus />
        <span className="sb-text">{t('Import a repo')}</span>
      </a>

      <nav className="sb-nav">
        {nav.map((n) => (
          <a
            key={n.id}
            href={href(n.to)}
            onClick={onNavigate}
            className={`sb-link${section === n.id && !currentSlug ? ' is-active' : ''}`}
            title={n.label}
            aria-current={section === n.id ? 'page' : undefined}
          >
            {n.icon}
            <span className="sb-text">{n.label}</span>
          </a>
        ))}
      </nav>

      <div className="sb-projects">
        <div className="sb-section-title sb-text">
          <span>{t('Projects')}</span>
          <span className="sb-count">{projects.data?.length ?? ''}</span>
        </div>
        {(projects.data?.length ?? 0) > 6 && (
          <label className="sb-filter sb-text">
            <IconSearch />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('Filter')} aria-label={t('Filter projects')} />
          </label>
        )}
        <ul className="sb-project-list">
          {list.map((p) => (
            <li key={p.slug}>
              <a
                href={href(`/projects/${p.slug}`)}
                onClick={onNavigate}
                className={`sb-project${currentSlug === p.slug ? ' is-active' : ''}`}
                title={`${p.slug} — ${p.domains[0]}`}
              >
                <ProjectIcon slug={p.slug} version={p.currentDeploymentId} className="sb-monogram">
                  <span className={`sb-dot ${dotClass(p)}`} />
                </ProjectIcon>
                <span className="sb-text sb-project-name">{p.slug}</span>
                {p.stopped ? (
                  <span className="sb-text sb-paused">{t('stopped')}</span>
                ) : (
                  p.paused && (
                    <span className="sb-text sb-paused" title={t('Auto-deploy paused')}>
                      auto-deploy ⏸
                    </span>
                  )
                )}
              </a>
            </li>
          ))}
          {projects.data && projects.data.length === 0 && (
            <li className="sb-text sb-empty">{t('No projects yet.')}</li>
          )}
        </ul>
      </div>

      <div className="sb-foot">
        {meta && meta.github.mode !== 'app' && (
          <a className="sb-github sb-text" href={href('/settings')} onClick={onNavigate}>
            <GithubMark /> {t('Connect GitHub')}
          </a>
        )}
        <div className="sb-user">
          {user.avatarUrl ? <img className="avatar" src={user.avatarUrl} alt="" /> : <span className="avatar avatar-empty" />}
          <span className="sb-text sb-user-name">
            <strong>{user.via === 'token' ? t('Admin token') : (user.name ?? user.login)}</strong>
            <span className="muted">{user.via === 'token' ? t('signed in with token') : `@${user.login}`}</span>
          </span>
          <button type="button" className="sb-icon-btn sb-text-btn" onClick={() => void logout()} title={t('Sign out')} aria-label={t('Sign out')}>
            <IconLogout />
          </button>
        </div>
      </div>
    </aside>
  );
}
