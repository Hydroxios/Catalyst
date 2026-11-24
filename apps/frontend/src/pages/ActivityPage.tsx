import { useMemo, useState } from 'react';
import { ErrorBox, Spinner, StatusBadge } from '../components/ui';
import { api, isTerminal, type Activity } from '../lib/api';
import { ago, deploymentDuration, shortSha, TRIGGER_LABEL } from '../lib/format';
import { usePoll, useTick } from '../lib/hooks';
import { href } from '../lib/router';
import { useCrumbs } from '../lib/shell';
import { dateLocale, t } from '../i18n';

type Filter = 'all' | 'running' | 'live' | 'failed';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'In progress' },
  { id: 'live', label: 'Went live' },
  { id: 'failed', label: 'Failures' },
];

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return t('Today');
  if (same(d, yesterday)) return t('Yesterday');
  return d.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
}

export function ActivityPage() {
  useCrumbs([{ label: t('Activity') }]);
  useTick();
  const activity = usePoll(() => api<Activity[]>('GET', '/deployments?limit=100'), [], 5000);
  const [filter, setFilter] = useState<Filter>('all');

  const groups = useMemo(() => {
    const list = (activity.data ?? []).filter((a) => {
      if (filter === 'running') return !isTerminal(a.status);
      if (filter === 'live') return a.status === 'live' || a.status === 'superseded' || a.status === 'rolled_back';
      if (filter === 'failed') return a.status === 'failed';
      return true;
    });
    const byDay = new Map<string, Activity[]>();
    for (const a of list) {
      const key = dayLabel(a.queued_at);
      byDay.set(key, [...(byDay.get(key) ?? []), a]);
    }
    return [...byDay.entries()];
  }, [activity.data, filter]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Activity')}</h1>
          <p className="muted">{t('The last 100 deployments, across all projects.')}</p>
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

      {activity.loading && !activity.data ? (
        <Spinner />
      ) : activity.error && !activity.data ? (
        <ErrorBox error={activity.error} onRetry={activity.reload} />
      ) : groups.length === 0 ? (
        <div className="empty">
          <h3>{t('Nothing to show')}</h3>
          <p className="muted">{t('Deployments will show up here after the first push.')}</p>
        </div>
      ) : (
        groups.map(([day, items]) => (
          <section key={day} className="activity-day">
            <h2 className="activity-day-title">{day}</h2>
            <div className="card glass card-flush">
              <ol className="activity-list">
                {items.map((a) => (
                  <li key={a.id}>
                    <a className="activity-row" href={href(`/deployments/${a.id}`)}>
                      <span className={`activity-dot pip-${a.status}`} aria-hidden />
                      <span className="activity-project">
                        <strong>{a.slug}</strong>
                        <span className="muted small">{TRIGGER_LABEL[a.trigger]}</span>
                      </span>
                      <span className="activity-commit">
                        <span className="mono">{shortSha(a.sha)}</span>
                        <span className="truncate">{a.error && a.status === 'failed' ? a.error : (a.commit_message ?? '')}</span>
                      </span>
                      <StatusBadge status={a.status} />
                      <span className="activity-meta muted small">
                        <span>{deploymentDuration(a)}</span>
                        <span>{ago(a.queued_at)}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
