import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, type BranchInfo } from '../lib/api';
import { ago } from '../lib/format';
import { t } from '../i18n';

/**
 * Choix de la branche : liste déroulante des branches du repo, les plus récemment poussées
 * d'abord (avec le dernier commit). La saisie libre reste possible.
 */
export function BranchPicker({
  repo,
  value,
  onChange,
  onDefaultBranch,
  disabled,
}: {
  repo: string;
  value: string;
  onChange: (branch: string) => void;
  /** Appelé une fois avec la branche par défaut du repo (pré-remplissage à l'import). */
  onDefaultBranch?: (branch: string) => void;
  disabled?: boolean;
}) {
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const defaultCb = useRef(onDefaultBranch);
  defaultCb.current = onDefaultBranch;

  useEffect(() => {
    setBranches(null);
    setError(false);
    if (disabled || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api<BranchInfo[]>('GET', `/github/repos/${repo}/branches`).then(
        (list) => {
          if (cancelled) return;
          setBranches(list);
          const def = list.find((b) => b.isDefault);
          if (def) defaultCb.current?.(def.name);
        },
        () => !cancelled && setError(true),
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [repo, disabled]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (branches ?? []).filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 30);
  }, [branches, filter]);

  const pick = (name: string) => {
    onChange(name);
    setFilter('');
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && shown[active]) {
      e.preventDefault();
      pick(shown[active]!.name);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  };

  const current = branches?.find((b) => b.name === value);

  return (
    <div className="branch-picker">
      <input
        ref={inputRef}
        className="input mono"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={open ? filter || value : value}
        placeholder={open ? t('Filter branches…') : 'main'}
        disabled={disabled}
        required
        spellCheck={false}
        autoComplete="off"
        onFocus={() => {
          setFilter('');
          setActive(0);
          setOpen(true);
        }}
        onBlur={() => {
          // Saisie libre : une branche qui n'est pas (encore) dans la liste reste acceptée.
          if (filter.trim()) onChange(filter.trim());
          setOpen(false);
        }}
        onChange={(e) => {
          setFilter(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {!open && current?.date && (
        <span className="branch-hint muted small">
          {t('last push {when}', { when: ago(current.date) })}
          {current.message ? ` · ${current.message}` : ''}
        </span>
      )}
      {open && (
        <ul className="branch-menu" id={listId} role="listbox">
          {branches === null && !error && <li className="branch-empty muted">{t('Loading branches…')}</li>}
          {error && <li className="branch-empty muted">{t('Branches unavailable: type the name manually.')}</li>}
          {branches !== null && shown.length === 0 && (
            <li className="branch-empty muted">
              {filter.trim() ? t('No matching branch: "{name}" will be used as is.', { name: filter.trim() }) : t('No matching branch.')}
            </li>
          )}
          {shown.map((b, i) => (
            <li
              key={b.name}
              role="option"
              aria-selected={b.name === value}
              className={`branch-option${i === active ? ' is-active' : ''}${b.name === value ? ' is-selected' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(b.name);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="branch-name mono">
                {b.name}
                {b.isDefault && <span className="branch-default">{t('default')}</span>}
              </span>
              <span className="branch-meta muted small">
                {b.date ? ago(b.date) : ''}
                {b.message ? ` · ${b.message}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
