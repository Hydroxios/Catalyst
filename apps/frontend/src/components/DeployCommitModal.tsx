import { useState, type FormEvent } from 'react';
import { api, type CommitInfo } from '../lib/api';
import { ago, shortSha } from '../lib/format';
import { usePoll } from '../lib/hooks';
import { Modal } from './Modal';
import { Button, ErrorBox, Spinner } from './ui';
import { t } from '../i18n';

/** Choisir un commit récent de la branche (ou coller un SHA) et le déployer. */
export function DeployCommitModal({
  slug,
  branch,
  liveSha,
  onClose,
  onDeploy,
}: {
  slug: string;
  branch: string;
  liveSha: string | null;
  onClose: () => void;
  onDeploy: (sha: string) => Promise<void>;
}) {
  const commits = usePoll(() => api<CommitInfo[]>('GET', `/projects/${slug}/commits`), [slug]);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const manualValid = /^[0-9a-f]{7,40}$/i.test(manual.trim());

  const deploy = async (sha: string) => {
    setBusy(sha);
    try {
      await onDeploy(sha);
    } finally {
      setBusy(null);
    }
  };
  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    if (manualValid) void deploy(manual.trim());
  };

  return (
    <Modal
      title={t('Deploy a commit')}
      description={
        <>
          {t('Latest commits on')} <span className="mono">{branch}</span>. {t('Deploying replaces the live version.')}
        </>
      }
      onClose={onClose}
      width={620}
      busy={busy !== null}
    >
      {commits.loading && !commits.data ? (
        <Spinner label={t('Loading commits…')} />
      ) : commits.error && !commits.data ? (
        <ErrorBox error={commits.error} onRetry={commits.reload} />
      ) : (
        <ul className="commit-list">
          {(commits.data ?? []).map((c) => {
            const isLive = c.sha === liveSha;
            return (
              <li key={c.sha} className={`commit-item${isLive ? ' is-live' : ''}`}>
                <span className="mono commit-sha">{shortSha(c.sha)}</span>
                <span className="commit-main">
                  <span className="truncate">{c.message ?? t('commit without a message')}</span>
                  <span className="muted small">
                    {c.author ?? t('unknown')} · {ago(c.date)}
                  </span>
                </span>
                {isLive ? (
                  <span className="badge badge-success">● {t('live')}</span>
                ) : (
                  <Button size="sm" busy={busy === c.sha} disabled={busy !== null} onClick={() => void deploy(c.sha)}>
                    {t('Deploy')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form className="commit-manual" onSubmit={submitManual}>
        <input
          className="input mono"
          placeholder={t('or paste a SHA (7 to 40 characters)')}
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          spellCheck={false}
          aria-label={t('Commit SHA')}
        />
        <Button type="submit" variant="primary" disabled={!manualValid || busy !== null} busy={busy === manual.trim()}>
          {t('Deploy this SHA')}
        </Button>
      </form>
    </Modal>
  );
}
