import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Card, ErrorBox, Spinner, StatusBadge } from '../components/ui';
import { api, isTerminal, streamLogs, type DeploymentDetail, type LogLine } from '../lib/api';
import { dateTime, deploymentDuration, shortSha, STATUS_LABEL, TRIGGER_LABEL, siteUrl } from '../lib/format';
import { usePoll, useTick } from '../lib/hooks';
import { href } from '../lib/router';
import { useCrumbs } from '../lib/shell';
import { useToast } from '../lib/toast';
import { dateLocale, t } from '../i18n';

/** Messages de Catalyst : ✔ succès (vert), ✖ échec (rouge), ⚠ avertissement (orange). */
function logTone(l: LogLine): string {
  if (l.stream !== 'system') return '';
  if (l.line.startsWith('✔')) return ' log-ok';
  if (l.line.startsWith('✖')) return ' log-error';
  if (l.line.startsWith('⚠')) return ' log-warn';
  return '';
}

const STEPS = ['queued', 'fetching', 'building', 'starting', 'healthchecking', 'live'] as const;

export function DeploymentPage({ id }: { id: number }) {
  const toast = useToast();
  useTick(1000);
  const dep = usePoll(() => api<DeploymentDetail>('GET', `/deployments/${id}`), [id], 2000);
  const slug = dep.data?.project.slug;
  useCrumbs([
    { label: t('Projects'), href: href('/') },
    ...(slug ? [{ label: slug, href: href(`/projects/${slug}`) }] : []),
    { label: t('Deployment #{id}', { id }) },
  ]);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  // Logs en direct, regroupés pour ne pas re-rendre à chaque ligne.
  useEffect(() => {
    setLines([]);
    setStreamError(null);
    const ctrl = new AbortController();
    let pending: LogLine[] = [];
    let lastId = 0;
    const flush = setInterval(() => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      setLines((l) => (l.length + batch.length > 20000 ? [...l, ...batch].slice(-20000) : [...l, ...batch]));
    }, 150);

    const run = async () => {
      // Reconnexion automatique si le flux coupe avant la fin.
      for (let attempt = 0; attempt < 20 && !ctrl.signal.aborted; attempt++) {
        try {
          const end = await streamLogs(
            id,
            lastId,
            (line) => {
              lastId = line.id;
              pending.push(line);
            },
            ctrl.signal,
          );
          if (end) {
            void dep.reload();
            return;
          }
        } catch (err) {
          if (ctrl.signal.aborted) return;
          setStreamError((err as Error).message);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void run();
    return () => {
      ctrl.abort();
      clearInterval(flush);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Suivi des logs : collé en bas par défaut ; coupé seulement si on remonte dans les logs,
  // et repris automatiquement quand on revient en bas.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    setFollow((f) => (f === atBottom ? f : atBottom));
  };

  if (dep.loading && !dep.data) return <Spinner />;
  if (dep.error && !dep.data) return <ErrorBox error={dep.error} onRetry={dep.reload} />;
  const d = dep.data!;
  const owner = d.project;
  const running = !isTerminal(d.status);
  const stepIndex = STEPS.indexOf(d.status as (typeof STEPS)[number]);

  const cancel = async () => {
    try {
      await api('POST', `/deployments/${d.id}/cancel`, {});
      toast.success(t('Cancellation requested'));
      await dep.reload();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="row gap-sm wrap">
            <h1>{t('Deployment #{id}', { id: d.id })}</h1>
            <StatusBadge status={d.status} />
          </div>
          <p className="muted">
            {owner ? (
              <a className="mono" href={`https://github.com/${owner.repo}/commit/${d.sha}`} target="_blank" rel="noreferrer">
                {shortSha(d.sha)}
              </a>
            ) : (
              <span className="mono">{shortSha(d.sha)}</span>
            )}{' '}
            {d.commit_message}
            {d.commit_author && <span> · {d.commit_author}</span>}
          </p>
        </div>
        <div className="row gap-sm">
          {d.status === 'live' && owner && (
            <a className="btn btn-primary" href={siteUrl(owner.domains[0]!)} target="_blank" rel="noreferrer">
              {t('Open site ↗')}
            </a>
          )}
          {(d.status === 'queued' || d.status === 'fetching' || d.status === 'building') && (
            <Button variant="danger" onClick={() => void cancel()}>
              {t('Cancel')}
            </Button>
          )}
        </div>
      </div>

      {running && stepIndex >= 0 && (
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i < stepIndex ? 'step-done' : i === stepIndex ? 'step-current' : ''}>
              {STATUS_LABEL[s]}
            </li>
          ))}
        </ol>
      )}

      {d.status === 'failed' && d.error && <div className="alert alert-danger pre">{d.error}</div>}

      <dl className="facts">
        <div>
          <dt>{t('Trigger')}</dt>
          <dd>{TRIGGER_LABEL[d.trigger]}</dd>
        </div>
        <div>
          <dt>{t('Started')}</dt>
          <dd>{dateTime(d.started_at ?? d.queued_at)}</dd>
        </div>
        <div>
          <dt>{t('Duration')}</dt>
          <dd>{deploymentDuration(d)}</dd>
        </div>
        <div>
          <dt>Image</dt>
          <dd className="mono small">{d.image_tag ?? '—'}</dd>
        </div>
      </dl>

      <Card className="card-flush">
        <div className="log-toolbar">
          <span className="muted small">
            {lines.length === 1 ? t('1 line') : t('{n} lines', { n: lines.length })}
            {running && ` · ${t('streaming')}`}
            {streamError && <span className="text-danger"> · {streamError}</span>}
          </span>
          <span className={`follow-state small${follow ? ' follow-on' : ''}`}>
            {follow ? t('Auto-follow') : t('Follow paused')}
          </span>
        </div>
        <div className="log-wrap">
          <div className="log" ref={logRef} onScroll={onLogScroll}>
            {lines.length === 0 && <div className="log-line muted">{running ? t('Waiting for logs…') : t('No logs.')}</div>}
            {lines.map((l) => (
              <div key={l.id} className={`log-line log-${l.stream}${logTone(l)}`}>
                <span className="log-ts">{new Date(l.ts).toLocaleTimeString(dateLocale())}</span>
                <span className="log-text">{l.line}</span>
              </div>
            ))}
          </div>
          {!follow && (
            <button type="button" className="btn btn-primary btn-sm follow-btn" onClick={() => setFollow(true)}>
              {t('↓ Resume following')}
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}
