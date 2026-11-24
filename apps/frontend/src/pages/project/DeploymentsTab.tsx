import { useDialog } from '../../components/Modal';
import { Button, Card, Empty, ErrorBox, Spinner, StatusBadge } from '../../components/ui';
import { api, isTerminal, type Deployment, type Project } from '../../lib/api';
import { ago, dateTime, deploymentDuration, shortSha, TRIGGER_LABEL } from '../../lib/format';
import { href, navigate } from '../../lib/router';
import { useToast } from '../../lib/toast';
import { t } from '../../i18n';

interface Resource {
  data: Deployment[] | null;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<void>;
}

export function DeploymentsTab({
  project,
  deployments,
  onChange,
}: {
  project: Project;
  deployments: Resource;
  onChange: () => Promise<void>;
}) {
  const toast = useToast();
  const dialog = useDialog();

  if (deployments.loading && !deployments.data) return <Spinner />;
  if (deployments.error && !deployments.data) return <ErrorBox error={deployments.error} onRetry={deployments.reload} />;
  const list = deployments.data ?? [];
  if (list.length === 0) {
    return (
      <Empty title={t('No deployments')}>
        <p className="muted">{t('Push a commit to {branch} or click "Deploy now".', { branch: project.branch })}</p>
      </Empty>
    );
  }

  const rollback = async (d: Deployment) => {
    const ok = await dialog.confirm({
      title: t('Roll back to version {sha}?', { sha: shortSha(d.sha) }),
      message: (
        <>
          <p>{d.commit_message ?? t('Deployment #{id}', { id: d.id })}</p>
          <p className="muted">{t('The existing image is reused with no rebuild: the switch takes a few seconds.')}</p>
        </>
      ),
      confirmLabel: t('Roll back to this version'),
    });
    if (!ok) return;
    try {
      const r = await api<{ deploymentId: number }>('POST', `/projects/${project.slug}/rollback`, { deploymentId: d.id });
      navigate(`/deployments/${r.deploymentId}`);
    } catch (err) {
      toast.error(err);
    }
  };
  const cancel = async (d: Deployment) => {
    try {
      await api('POST', `/deployments/${d.id}/cancel`, {});
      toast.success(t('Deployment #{id} cancelled', { id: d.id }));
      await onChange();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <Card className="card-flush">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('Status')}</th>
              <th>Commit</th>
              <th className="hide-sm">{t('Trigger')}</th>
              <th className="hide-sm">{t('Duration')}</th>
              <th>{t('When')}</th>
              <th aria-label={t('Actions')} />
            </tr>
          </thead>
          <tbody>
            {list.map((d) => {
              const isLive = d.id === project.currentDeploymentId;
              const canRollback =
                !isLive && d.image_tag && d.went_live_at && isTerminal(d.status) && project.enabled;
              const canCancel = d.status === 'queued' || d.status === 'fetching' || d.status === 'building';
              return (
                <tr key={d.id} className={isLive ? 'row-live' : undefined}>
                  <td>
                    <a href={href(`/deployments/${d.id}`)}>#{d.id}</a>
                  </td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="commit-cell">
                    <a
                      className="mono"
                      href={`https://github.com/${project.repo}/commit/${d.sha}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortSha(d.sha)}
                    </a>{' '}
                    <span className="truncate">{d.commit_message ?? ''}</span>
                    {d.status === 'failed' && d.error && <div className="text-danger small truncate">{d.error}</div>}
                  </td>
                  <td className="hide-sm nowrap">{TRIGGER_LABEL[d.trigger]}</td>
                  <td className="hide-sm nowrap">{deploymentDuration(d)}</td>
                  <td className="nowrap" title={dateTime(d.queued_at)}>{ago(d.queued_at)}</td>
                  <td className="actions">
                    <Button size="sm" variant="ghost" onClick={() => navigate(`/deployments/${d.id}`)}>
                      Logs
                    </Button>
                    {canRollback && (
                      <Button size="sm" onClick={() => void rollback(d)}>
                        {t('Roll back to this version')}
                      </Button>
                    )}
                    {canCancel && (
                      <Button size="sm" variant="danger" onClick={() => void cancel(d)}>
                        {t('Cancel')}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
