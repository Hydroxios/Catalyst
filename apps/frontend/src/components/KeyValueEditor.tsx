import { useState } from 'react';
import type { EnvVar } from '../lib/api';
import { Button } from './ui';
import { t } from '../i18n';

/** Éditeur de paires clé/valeur (variables d'env, build args). */
export function KeyValueEditor({
  rows,
  onChange,
  secret = false,
  readOnly = false,
  keyPlaceholder = 'KEY',
  valuePlaceholder = t('value'),
}: {
  rows: EnvVar[];
  onChange: (rows: EnvVar[]) => void;
  secret?: boolean;
  readOnly?: boolean;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const update = (i: number, patch: Partial<EnvVar>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="kv">
      {rows.length === 0 && <p className="muted small">{t('No variables.')}</p>}
      {rows.map((row, i) => (
        <div className="kv-row" key={i}>
          <input
            className="input mono"
            value={row.key}
            placeholder={keyPlaceholder}
            readOnly={readOnly}
            spellCheck={false}
            onChange={(e) => update(i, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
            aria-label={t('Name')}
          />
          <input
            className="input mono"
            type={secret && !revealed ? 'password' : 'text'}
            value={row.value}
            placeholder={valuePlaceholder}
            readOnly={readOnly}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => update(i, { value: e.target.value })}
            aria-label={t('Value')}
          />
          {!readOnly && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('Remove')}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              ✕
            </Button>
          )}
        </div>
      ))}
      <div className="row gap-sm">
        {!readOnly && (
          <Button type="button" size="sm" onClick={() => onChange([...rows, { key: '', value: '' }])}>
            {t('+ Add')}
          </Button>
        )}
        {secret && rows.length > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setRevealed((r) => !r)}>
            {revealed ? t('Hide values') : t('Show values')}
          </Button>
        )}
      </div>
    </div>
  );
}
