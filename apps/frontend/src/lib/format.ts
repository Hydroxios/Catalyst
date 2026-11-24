import { dateLocale, t } from '../i18n';
import type { Deployment, DeploymentStatus } from './api';

let scheme: 'http' | 'https' = 'https';

/** Fixé au chargement de /api/meta : http en local (pas de certificats), https sinon. */
export function setSiteScheme(s: 'http' | 'https' | undefined): void {
  if (s) scheme = s;
}

/** Lien vers un site déployé. */
export const siteUrl = (host: string) => `${scheme}://${host}`;

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 10) return t('just now');
  if (s < 60) return t('{n}s ago', { n: s });
  if (s < 3600) return t('{n}m ago', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n}h ago', { n: Math.round(s / 3600) });
  return t('{n}d ago', { n: Math.round(s / 86400) });
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return t('{s}s', { s });
  return t('{m}m {s}s', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') });
}

export function deploymentDuration(d: Pick<Deployment, 'started_at' | 'finished_at'>): string {
  if (!d.started_at) return '—';
  const end = d.finished_at ? new Date(d.finished_at).getTime() : Date.now();
  return duration(end - new Date(d.started_at).getTime());
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'medium' });
}

export const shortSha = (sha: string) => sha.slice(0, 7);

const STATUS_EN: Record<DeploymentStatus, string> = {
  queued: 'Queued',
  fetching: 'Fetching',
  building: 'Building',
  starting: 'Starting',
  healthchecking: 'Checking',
  live: 'Live',
  failed: 'Failed',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
  rolled_back: 'Rolled back',
};

const TRIGGER_EN: Record<Deployment['trigger'], string> = {
  webhook: 'push',
  poll: 'polling',
  manual: 'manual',
  rollback: 'rollback',
};

/** Libellés traduits à la lecture (`STATUS_LABEL[status]`), donc toujours dans la langue courante. */
const translated = <K extends string>(source: Record<K, string>) =>
  new Proxy({} as Record<K, string>, { get: (_, key: string) => t(source[key as K] ?? key) });

export const STATUS_LABEL = translated(STATUS_EN);
export const TRIGGER_LABEL = translated(TRIGGER_EN);

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31);
}
