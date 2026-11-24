import { useState } from 'react';
import { useDialog } from '../../components/Modal';
import { ProjectForm } from '../../components/ProjectForm';
import { Button, Card } from '../../components/ui';
import { api, type Meta, type Project, type ProjectInput } from '../../lib/api';
import { navigate } from '../../lib/router';
import { useProjects } from '../../lib/shell';
import { useToast } from '../../lib/toast';
import { t } from '../../i18n';

export function SettingsTab({
  project,
  meta,
  onSaved,
  onRedeploy,
}: {
  project: Project;
  meta: Meta;
  onSaved: () => Promise<void>;
  onRedeploy: () => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const projects = useProjects();
  const [deleting, setDeleting] = useState(false);
  const fromFile = project.managedBy === 'file';

  const save = async (input: ProjectInput) => {
    await api('PUT', `/projects/${project.slug}`, input);
    await onSaved();
    toast.success(t('Settings saved — they apply on the next deployment'), {
      label: t('Redeploy'),
      onClick: onRedeploy,
    });
  };

  const remove = async () => {
    const ok = await dialog.confirm({
      title: t('Delete {slug}?', { slug: project.slug }),
      message: (
        <>
          <p>{t('The site stops right away and the project is removed from Catalyst.')}</p>
          <p className="muted">{t('Deployment history and environment variables are kept on the server.')}</p>
        </>
      ),
      confirmLabel: t('Delete project'),
      danger: true,
      typeToConfirm: project.slug,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api('DELETE', `/projects/${project.slug}`);
      toast.success(t('{slug} deleted', { slug: project.slug }));
      void projects.reload();
      navigate('/');
    } catch (err) {
      toast.error(err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="stack">
      {fromFile && (
        <div className="alert alert-info">
          {t('This project is defined in')} <span className="mono">projects.yml</span>{' '}
          {t('on the server: edit that file, then restart Catalyst. To manage it from here, remove it from the file and create it again from the interface.')}
        </div>
      )}
      <Card>
        <ProjectForm
          key={JSON.stringify(project.config)}
          mode="edit"
          meta={meta}
          initial={project.config}
          readOnly={fromFile || !project.enabled}
          onSubmit={save}
        />
      </Card>
      {!fromFile && project.enabled && (
        <Card className="danger-zone">
          <div className="card-head">
            <div>
              <h2>{t('Delete project')}</h2>
              <p className="muted small">{t('Stops the site and removes it from Catalyst. Environment variables are kept on the server.')}</p>
            </div>
            <Button variant="danger" busy={deleting} onClick={() => void remove()}>
              {t('Delete')}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
