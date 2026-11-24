import { useState } from 'react';
import { DeployCommitModal } from '../../components/DeployCommitModal';
import { useDialog } from '../../components/Modal';
import { ProjectIcon } from '../../components/ProjectIcon';
import { Badge, Button, ErrorBox, Spinner, StatusBadge } from '../../components/ui';
import { siteUrl } from '../../lib/format';
import { api, isTerminal, type Deployment, type Meta, type Project } from '../../lib/api';
import { useAction, usePoll, useTick } from '../../lib/hooks';
import { href, navigate } from '../../lib/router';
import { useCrumbs, useProjects } from '../../lib/shell';
import { useToast } from '../../lib/toast';
import { DeploymentsTab } from './DeploymentsTab';
import { DomainsTab } from './DomainsTab';
import { EnvTab } from './EnvTab';
import { SettingsTab } from './SettingsTab';
import { t } from '../../i18n';

const TABS = [
  { id: 'deployments', label: 'Deployments' },
  { id: 'env', label: 'Variables' },
  { id: 'domains', label: 'Domain & webhook' },
  { id: 'settings', label: 'Settings' },
] as const;

export function ProjectPage({ slug, tab = 'deployments', meta }: { slug: string; tab?: string; meta: Meta }) {
  const toast = useToast();
  const dialog = useDialog();
  const projects = useProjects();
  const [commitPicker, setCommitPicker] = useState(false);
  useTick();
  useCrumbs([{ label: t('Projects'), href: href('/') }, { label: slug }]);
  const project = usePoll(() => api<Project>('GET', `/projects/${slug}`), [slug], 4000);
  const deployments = usePoll(() => api<Deployment[]>('GET', `/projects/${slug}/deployments?limit=50`), [slug], 3000);
  const reload = async () => {
    await Promise.all([project.reload(), deployments.reload()]);
  };

  const [deploy, deploying] = useAction(async (sha?: string) => {
    try {
      const r = await api<{ deploymentId: number }>('POST', `/projects/${slug}/deploy`, sha ? { sha } : {});
      navigate(`/deployments/${r.deploymentId}`);
    } catch (err) {
      toast.error(err);
    }
  });
  const [togglePause, toggling] = useAction(async () => {
    const paused = project.data?.paused;
    try {
      await api('POST', `/projects/${slug}/${paused ? 'resume' : 'pause'}`, {});
      toast.success(paused ? t('Auto-deploy resumed') : t('Auto-deploy paused'));
      await project.reload();
    } catch (err) {
      toast.error(err);
    }
  });

  const [toggleRunning, togglingRunning] = useAction(async () => {
    const stopped = project.data?.stopped;
    if (
      !stopped &&
      !(await dialog.confirm({
        title: t('Stop {slug}?', { slug }),
        message: (
          <>
            <p>{t("The site won't respond until you start it again.")}</p>
            <p className="muted">
              {t('Nothing is deleted: starting it again is instant, with no rebuild. Auto-deploy is paused while the site is stopped.')}
            </p>
          </>
        ),
        confirmLabel: t('Stop the site'),
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await api('POST', `/projects/${slug}/${stopped ? 'start' : 'stop'}`, {});
      toast.success(stopped ? t('Site started') : t('Site stopped'));
      await Promise.all([project.reload(), projects.reload()]);
    } catch (err) {
      toast.error(err);
    }
  });

  if (project.loading && !project.data) return <Spinner />;
  if (project.error && !project.data) return <ErrorBox error={project.error} onRetry={project.reload} />;
  const p = project.data!;
  const active = (deployments.data ?? []).find((d) => !isTerminal(d.status));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="row gap-sm wrap">
            <ProjectIcon slug={p.slug} version={p.currentDeploymentId} className="project-icon project-icon-lg" />
            <h1>{p.slug}</h1>
            {p.stopped ? (
              <Badge tone="neutral">■ {t('stopped')}</Badge>
            ) : p.live ? (
              <StatusBadge status="live" />
            ) : (
              <Badge>{t('not live')}</Badge>
            )}
            {p.paused && <Badge tone="warning">{t('auto-deploy paused')}</Badge>}
            {p.managedBy === 'file' && (
              <Badge tone="muted" title={t('Defined in projects.yml')}>
                projects.yml
              </Badge>
            )}
          </div>
          <p className="muted row gap-sm wrap">
            <a href={siteUrl(p.domains[0]!)} target="_blank" rel="noreferrer">
              {p.domains[0]} ↗
            </a>
            <span>·</span>
            <a className="mono" href={`https://github.com/${p.repo}/tree/${p.branch}`} target="_blank" rel="noreferrer">
              {p.repo}@{p.branch}
            </a>
          </p>
        </div>
        <div className="row gap-sm wrap">
          {p.live && (
            <Button
              variant={p.stopped ? 'secondary' : 'danger'}
              busy={togglingRunning}
              onClick={() => void toggleRunning()}
              disabled={!p.enabled}
            >
              {p.stopped ? t('▶ Start the site') : t('■ Stop the site')}
            </Button>
          )}
          <Button
            busy={toggling}
            onClick={() => void togglePause()}
            disabled={!p.enabled || p.stopped}
            title={p.stopped ? t('Auto-deploy is paused while the site is stopped') : undefined}
          >
            {p.paused ? t('Resume auto-deploy') : t('Pause auto-deploy')}
          </Button>
          <Button
            onClick={() => setCommitPicker(true)}
            disabled={!p.enabled}
          >
            {t('Deploy a commit…')}
          </Button>
          {active ? (
            <Button variant="primary" onClick={() => navigate(`/deployments/${active.id}`)}>
              {t('Follow the deployment')}
            </Button>
          ) : (
            <Button variant="primary" busy={deploying} disabled={!p.enabled} onClick={() => void deploy()}>
              {t('Deploy now')}
            </Button>
          )}
        </div>
      </div>

      <nav className="tabs" role="tablist">
        {TABS.map((tb) => (
          <a
            key={tb.id}
            role="tab"
            aria-selected={tab === tb.id}
            className={`tab${tab === tb.id ? ' tab-active' : ''}`}
            href={href(`/projects/${slug}/${tb.id}`)}
          >
            {t(tb.label)}
          </a>
        ))}
      </nav>

      {tab === 'deployments' && <DeploymentsTab project={p} deployments={deployments} onChange={reload} />}
      {tab === 'env' && <EnvTab project={p} onRedeploy={() => void deploy()} />}
      {tab === 'domains' && <DomainsTab project={p} meta={meta} />}
      {tab === 'settings' && <SettingsTab project={p} meta={meta} onSaved={reload} onRedeploy={() => void deploy()} />}
      {commitPicker && (
        <DeployCommitModal
          slug={p.slug}
          branch={p.branch}
          liveSha={p.live?.sha ?? null}
          onClose={() => setCommitPicker(false)}
          onDeploy={async (sha) => {
            await deploy(sha);
            setCommitPicker(false);
          }}
        />
      )}
    </div>
  );
}
