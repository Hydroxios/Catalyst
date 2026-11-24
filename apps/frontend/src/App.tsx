import { Fragment, useCallback, useEffect, useState } from 'react';
import { IconClose, IconMenu } from './components/icons';
import { Sidebar } from './components/Sidebar';
import { ErrorBox, Spinner } from './components/ui';
import { api, getMe, type Meta, type User } from './lib/api';
import { setSiteScheme } from './lib/format';
import { usePoll } from './lib/hooks';
import { href, match, useRoute } from './lib/router';
import { CrumbsProvider, ProjectsProvider, useCrumbs, useCrumbsValue } from './lib/shell';
import { ActivityPage } from './pages/ActivityPage';
import { Dashboard } from './pages/Dashboard';
import { DeploymentPage } from './pages/DeploymentPage';
import { Login } from './pages/Login';
import { NewProject } from './pages/NewProject';
import { ProjectPage } from './pages/project/ProjectPage';
import { SettingsPage } from './pages/SettingsPage';
import { LanguageSwitcher } from './i18n';
import { t } from './i18n';

/** Session courante : cookie GitHub ou token admin (localStorage). */
function useSession() {
  const [state, setState] = useState<{ user: User | null; loading: boolean; error: Error | null }>({
    user: null,
    loading: true,
    error: null,
  });
  const check = useCallback(() => {
    getMe().then(
      (user) => setState({ user, loading: false, error: null }),
      (error: Error) => setState({ user: null, loading: false, error }),
    );
  }, []);
  useEffect(() => {
    check();
    window.addEventListener('catalyst:auth', check);
    return () => window.removeEventListener('catalyst:auth', check);
  }, [check]);
  return { ...state, recheck: check };
}

export function App() {
  const session = useSession();
  if (session.loading) return <Spinner />;
  if (session.error) return <ErrorBox error={session.error} onRetry={session.recheck} />;
  if (!session.user) return <Login />;
  return (
    <ProjectsProvider>
      <CrumbsProvider>
        <Shell user={session.user} />
      </CrumbsProvider>
    </ProjectsProvider>
  );
}

const COLLAPSE_KEY = 'catalyst.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function Shell({ user }: { user: User }) {
  const path = useRoute();
  const meta = usePoll(() => api<Meta>('GET', '/meta').then((m) => (setSiteScheme(m.siteScheme), m)), []);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);

  // Le tiroir mobile se referme à chaque changement de page.
  useEffect(() => setDrawer(false), [path]);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        // préférence non mémorisée
      }
      return !c;
    });

  let page: JSX.Element;
  let params: Record<string, string> | null;
  if (meta.loading && !meta.data) page = <Spinner />;
  else if (meta.error && !meta.data) page = <ErrorBox error={meta.error} onRetry={meta.reload} />;
  else if (match('/', path)) page = <Dashboard meta={meta.data!} />;
  else if (match('/new', path)) page = <NewProject meta={meta.data!} />;
  else if (match('/activity', path)) page = <ActivityPage />;
  else if (match('/settings', path)) page = <SettingsPage onChange={meta.reload} />;
  else if ((params = match('/projects/:slug/:tab?', path)))
    page = <ProjectPage key={params.slug} slug={params.slug!} tab={params.tab} meta={meta.data!} />;
  else if ((params = match('/deployments/:id', path))) page = <DeploymentPage key={params.id} id={Number(params.id)} />;
  else page = <NotFound />;

  return (
    <div className={`app${collapsed ? ' sb-collapsed' : ''}${drawer ? ' drawer-open' : ''}`}>
      <div className="backdrop" aria-hidden />
      <Sidebar
        user={user}
        meta={meta.data}
        path={path}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        onNavigate={() => setDrawer(false)}
      />
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} aria-hidden />}
      <div className="main">
        <header className="main-bar">
          <button
            type="button"
            className="sb-icon-btn menu-btn"
            onClick={() => setDrawer((d) => !d)}
            aria-label={drawer ? t('Close menu') : t('Open menu')}
          >
            {drawer ? <IconClose /> : <IconMenu />}
          </button>
          <Breadcrumbs />
          <div className="main-bar-end">
            <LanguageSwitcher />
          </div>
        </header>
        <main className="content">{page}</main>
      </div>
    </div>
  );
}

function Breadcrumbs() {
  const crumbs = useCrumbsValue();
  return (
    <nav className="crumbs" aria-label={t('Breadcrumb')}>
      {crumbs.map((c, i) => (
        <Fragment key={`${c.label}-${i}`}>
          {i > 0 && <span className="crumb-sep">/</span>}
          {c.href && i < crumbs.length - 1 ? (
            <a href={c.href}>{c.label}</a>
          ) : (
            <span className="crumb-current" aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
              {c.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

function NotFound() {
  useCrumbs([{ label: t('Page not found') }]);
  return (
    <div className="page">
      <h1>{t('Page not found')}</h1>
      <a href={href('/')}>{t('Back to projects')}</a>
    </div>
  );
}
