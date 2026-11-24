import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { DeploymentStatus } from '../lib/api';
import { STATUS_LABEL } from '../lib/format';
import { t } from '../i18n';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid';

export function Button({
  variant = 'secondary',
  size,
  busy,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm'; busy?: boolean }) {
  return (
    <button
      className={`btn btn-${variant}${size ? ` btn-${size}` : ''} ${className}`}
      disabled={busy || rest.disabled}
      {...rest}
    >
      {busy && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

const STATUS_TONE: Record<DeploymentStatus, string> = {
  queued: 'progress',
  fetching: 'progress',
  building: 'progress',
  starting: 'progress',
  healthchecking: 'progress',
  live: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  superseded: 'muted',
  rolled_back: 'warning',
};

/** Monochrome : le statut se lit à la forme de l'icône et au remplissage du badge. */
const STATUS_ICON: Record<string, string> = {
  success: '●',
  danger: '✕',
  warning: '↺',
  neutral: '○',
  muted: '–',
};

export function StatusBadge({ status }: { status: DeploymentStatus }) {
  const tone = STATUS_TONE[status];
  return (
    <span className={`badge badge-${tone}`}>
      {tone === 'progress' ? <span className="ring" aria-hidden /> : <span className="badge-icon" aria-hidden>{STATUS_ICON[tone]}</span>}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Badge({ tone = 'neutral', children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card glass ${className}`}>{children}</section>;
}

export function Spinner({ label = t('Loading…') }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" aria-hidden /> {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="alert alert-danger">
      <span>{error.message}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {t('Retry')}
        </Button>
      )}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Copy({ value }: { value: string }) {
  return (
    <span className="copy">
      <code>{value}</code>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => void navigator.clipboard?.writeText(value)}
        title={t('Copy')}
      >
        {t('Copy')}
      </button>
    </span>
  );
}
