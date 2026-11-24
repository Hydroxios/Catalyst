import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, type EnvVar, type Meta, type ProjectConfig, type ProjectInput } from '../lib/api';
import { slugify } from '../lib/format';
import { BranchPicker } from './BranchPicker';
import { KeyValueEditor } from './KeyValueEditor';
import { Button, Field } from './ui';
import { t } from '../i18n';

interface Repo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface CreateOptions {
  deployNow: boolean;
  setupWebhook: boolean;
}

const HOST_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** Domaine sans sous-domaine (heuristique : deux libellés, ex. mondomaine.fr). */
export const isApex = (d: string) => d.split('.').length === 2;

export function ProjectForm({
  initial,
  defaults,
  meta,
  mode,
  readOnly = false,
  lockRepo = false,
  detectedBuild,
  detectedStart,
  onSubmit,
}: {
  initial?: ProjectConfig;
  /** Pré-remplissage en création (repo importé). */
  defaults?: Partial<ProjectConfig>;
  /** Repo choisi à l'étape d'import : non modifiable ici. */
  lockRepo?: boolean;
  /** Commandes proposées par la détection automatique (affichées en exemple). */
  detectedBuild?: string | null;
  detectedStart?: string | null;
  meta: Meta;
  mode: 'create' | 'edit';
  readOnly?: boolean;
  onSubmit: (input: ProjectInput, options: CreateOptions) => Promise<void>;
}) {
  const defaultDomain = (slug: string) => `${slug || '<slug>'}.${meta.baseDomain}`;
  const initialCustom = initial ? !(initial.domains.length === 1 && initial.domains[0] === defaultDomain(initial.slug)) : false;

  const seed: Partial<ProjectConfig> | undefined = initial ?? defaults;
  const [repo, setRepo] = useState(seed?.repo ?? '');
  const [slug, setSlug] = useState(seed?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(mode === 'edit');
  const [branch, setBranch] = useState(seed?.branch ?? 'main');
  const [port, setPort] = useState(String(seed?.port ?? 3000));
  const [domainMode, setDomainMode] = useState<'default' | 'custom'>(initialCustom ? 'custom' : 'default');
  const [domainsText, setDomainsText] = useState(initialCustom ? initial!.domains.join('\n') : '');
  const [wwwRedirect, setWwwRedirect] = useState(seed?.www_redirect ?? false);
  const [dockerfile, setDockerfile] = useState(seed?.dockerfile ?? 'Dockerfile');
  const [buildCommand, setBuildCommand] = useState(seed?.build_command ?? '');
  const [startCommand, setStartCommand] = useState(seed?.start_command ?? '');
  const [context, setContext] = useState(seed?.context ?? '.');
  const [healthPath, setHealthPath] = useState(seed?.healthcheck?.path ?? '/');
  const [healthTimeout, setHealthTimeout] = useState(String(seed?.healthcheck?.timeout_seconds ?? ''));
  const [healthMode, setHealthMode] = useState<'docker' | 'worker'>(seed?.healthcheck?.mode ?? 'docker');
  const [memory, setMemory] = useState(seed?.resources?.memory ?? '512m');
  const [cpus, setCpus] = useState(seed?.resources?.cpus ?? '0.5');
  const [buildArgs, setBuildArgs] = useState<EnvVar[]>(
    Object.entries(seed?.build_args ?? {}).map(([key, value]) => ({ key, value })),
  );
  const [deployOnFirstSeen, setDeployOnFirstSeen] = useState(seed?.deploy_on_first_seen ?? true);
  const [deployNow, setDeployNow] = useState(true);
  const [setupWebhook, setSetupWebhook] = useState(true);

  const [repos, setRepos] = useState<Repo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Suggestions de repos accessibles avec le token GitHub (facultatif).
  useEffect(() => {
    if (readOnly) return;
    api<Repo[]>('GET', '/github/repos').then(setRepos, () => setRepos([]));
  }, [readOnly]);

  // Slug déduit du nom du repo tant que l'utilisateur ne l'a pas modifié.
  useEffect(() => {
    if (!slugTouched) setSlug(slugify(repo.split('/')[1] ?? ''));
  }, [repo, slugTouched]);

  const domains = useMemo(
    () =>
      domainsText
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        .filter(Boolean),
    [domainsText],
  );
  const invalidDomains = domains.filter((d) => !HOST_RE.test(d));
  const hasApex = domainMode === 'custom' && domains.some(isApex);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (domainMode === 'custom' && domains.length === 0) return setError(t('Enter at least one domain.'));
    if (invalidDomains.length > 0) return setError(t('Invalid domain: {list}', { list: invalidDomains.join(', ') }));
    const timeout = healthTimeout.trim() ? Number(healthTimeout) : undefined;
    const input: ProjectInput = {
      slug,
      repo: repo.trim(),
      branch: branch.trim(),
      dockerfile: dockerfile.trim(),
      ...(buildCommand.trim() ? { build_command: buildCommand.trim() } : {}),
      ...(startCommand.trim() ? { start_command: startCommand.trim() } : {}),
      context: context.trim(),
      port: Number(port),
      ...(domainMode === 'custom' ? { domains } : {}),
      www_redirect: domainMode === 'custom' && wwwRedirect,
      healthcheck: { path: healthPath.trim() || '/', mode: healthMode, ...(timeout ? { timeout_seconds: timeout } : {}) },
      resources: { memory: memory.trim(), cpus: cpus.trim() },
      build_args: Object.fromEntries(buildArgs.filter((a) => a.key).map((a) => [a.key, a.value])),
      deploy_on_first_seen: deployOnFirstSeen,
    };
    setBusy(true);
    try {
      await onSubmit(input, { deployNow, setupWebhook: setupWebhook && meta.github.mode !== 'app' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <fieldset disabled={readOnly || busy}>
        <h3 className="form-section">{t('Source')}</h3>
        <div className="grid-2">
          <Field label={t('GitHub repo')} hint={t('owner/name')}>
            <input
              className="input"
              list="catalyst-repos"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/my-site"
              readOnly={lockRepo}
              required
              pattern="[\w.\-]+/[\w.\-]+"
              spellCheck={false}
              autoFocus={mode === 'create'}
            />
            <datalist id="catalyst-repos">
              {repos.map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.private ? t('private') : t('public')}
                </option>
              ))}
            </datalist>
          </Field>
          <div className="field">
            <span className="field-label">{t('Tracked branch')}</span>
            <BranchPicker
              repo={repo}
              value={branch}
              onChange={setBranch}
              disabled={readOnly}
              // À la création sans branche imposée : la branche par défaut du repo.
              onDefaultBranch={mode === 'create' && !defaults?.branch ? setBranch : undefined}
            />
          </div>
        </div>
        <div className="grid-2">
          <Field
            label={t('Project name')}
            hint={mode === 'edit' ? t('Cannot be changed') : t('Lowercase letters, digits, and hyphens')}
          >
            <input
              className="input mono"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(slugify(e.target.value));
              }}
              readOnly={mode === 'edit'}
              required
              pattern="[a-z0-9][a-z0-9\-]{1,30}"
            />
          </Field>
          <Field label={t('App port')} hint={t('Port the app listens on inside the container')}>
            <input
              className="input"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              required
            />
          </Field>
        </div>

        <h3 className="form-section">{t('Domain')}</h3>
        <div className="choice-group" role="radiogroup">
          <label className={`choice${domainMode === 'default' ? ' choice-active' : ''}`}>
            <input
              type="radio"
              name="domainMode"
              checked={domainMode === 'default'}
              onChange={() => setDomainMode('default')}
            />
            <span>
              <strong>{t('Automatic subdomain')}</strong>
              <span className="muted mono small">{defaultDomain(slug)}</span>
            </span>
          </label>
          <label className={`choice${domainMode === 'custom' ? ' choice-active' : ''}`}>
            <input
              type="radio"
              name="domainMode"
              checked={domainMode === 'custom'}
              onChange={() => setDomainMode('custom')}
            />
            <span>
              <strong>{t('Custom domain')}</strong>
              <span className="muted small">{t('Root domain (mydomain.com) or any subdomain')}</span>
            </span>
          </label>
        </div>
        {domainMode === 'custom' && (
          <>
            <Field
              label={t('Domains')}
              hint={t('One per line. The first one is the main address.')}
              error={invalidDomains.length ? `Invalide : ${invalidDomains.join(', ')}` : undefined}
            >
              <textarea
                className="input mono"
                rows={Math.max(2, domains.length + 1)}
                value={domainsText}
                onChange={(e) => setDomainsText(e.target.value)}
                placeholder="mydomain.com"
                spellCheck={false}
              />
            </Field>
            <label className="check">
              <input type="checkbox" checked={wwwRedirect} onChange={(e) => setWwwRedirect(e.target.checked)} />
              <span>
                {t('Redirect')} <span className="mono">www.</span> {t('to the domain')}
                {hasApex && <span className="muted"> {t('(recommended for a root domain)')}</span>}
              </span>
            </label>
            {hasApex && (
              <p className="alert alert-info small">
                {t("A root domain isn't covered by the wildcard DNS record")} <span className="mono">*.{meta.baseDomain}</span>:{' '}
                {t('create an')} <strong>A</strong> {t('record for')} <span className="mono">@</span>
                {wwwRedirect && (
                  <>
                    {' '}
                    {t('and for')} <span className="mono">www</span>
                  </>
                )}{' '}
                {t('pointing to')} {meta.serverIps.length ? <span className="mono">{meta.serverIps.join(', ')}</span> : t("the server's IP")}
                . {t('The HTTPS certificate is issued automatically.')}
              </p>
            )}
          </>
        )}

        <details className="advanced">
          <summary>{t('Build, start, healthcheck, and resources')}</summary>
          <div className="grid-2">
            <Field label={t('Build command')} hint={t('Empty = detected automatically')}>
              <input
                className="input mono"
                value={buildCommand}
                onChange={(e) => setBuildCommand(e.target.value)}
                placeholder={detectedBuild ?? 'npm run build'}
                spellCheck={false}
              />
            </Field>
            <Field label={t('Start command')} hint={t('Empty = detected automatically')}>
              <input
                className="input mono"
                value={startCommand}
                onChange={(e) => setStartCommand(e.target.value)}
                placeholder={detectedStart ?? 'npm start'}
                spellCheck={false}
              />
            </Field>
          </div>
          <div className="grid-2">
            <Field label="Dockerfile" hint={t("Used if it exists; otherwise the stack is detected and a Dockerfile is generated")}>
              <input className="input mono" value={dockerfile} onChange={(e) => setDockerfile(e.target.value)} required />
            </Field>
            <Field label={t('Build context')}>
              <input className="input mono" value={context} onChange={(e) => setContext(e.target.value)} required />
            </Field>
          </div>
          <div className="grid-3">
            <Field label="Healthcheck" hint={t('GET must return 2xx/3xx')}>
              <input className="input mono" value={healthPath} onChange={(e) => setHealthPath(e.target.value)} />
            </Field>
            <Field label={t('Max wait (s)')} hint={t('Empty = global default')}>
              <input
                className="input"
                type="number"
                min={5}
                value={healthTimeout}
                onChange={(e) => setHealthTimeout(e.target.value)}
              />
            </Field>
            <Field
              label={t('Rollout')}
              hint={healthMode === 'docker' ? t('Zero downtime; needs wget, curl, node, or python in the image') : t('Up to ~1s of downtime')}
            >
              <select className="input" value={healthMode} onChange={(e) => setHealthMode(e.target.value as 'docker')}>
                <option value="docker">{t('Zero downtime (Docker healthcheck)')}</option>
                <option value="worker">{t('Simple (checked by Catalyst)')}</option>
              </select>
            </Field>
          </div>
          <div className="grid-2">
            <Field label={t('Max memory')} hint={t('e.g. 512m, 1g')}>
              <input className="input mono" value={memory} onChange={(e) => setMemory(e.target.value)} />
            </Field>
            <Field label={t('Max CPU')} hint={t('e.g. 0.5, 1, 2')}>
              <input className="input mono" value={cpus} onChange={(e) => setCpus(e.target.value)} />
            </Field>
          </div>
          <Field label="Build args" hint={t('Passed to docker build (no secrets here: they stay in the image)')}>
            <KeyValueEditor rows={buildArgs} onChange={setBuildArgs} readOnly={readOnly} />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={deployOnFirstSeen}
              onChange={(e) => setDeployOnFirstSeen(e.target.checked)}
            />
            <span>{t('Deploy the current commit when the project is first detected')}</span>
          </label>
        </details>

        {mode === 'create' && (
          <div className="stack-sm">
            <label className="check">
              <input type="checkbox" checked={deployNow} onChange={(e) => setDeployNow(e.target.checked)} />
              <span>{t('Deploy right away')}</span>
            </label>
            {meta.github.mode !== 'app' && (
              <label className="check">
                <input type="checkbox" checked={setupWebhook} onChange={(e) => setSetupWebhook(e.target.checked)} />
                <span>{t('Set up the GitHub webhook automatically (deploy on every push)')}</span>
              </label>
            )}
          </div>
        )}
      </fieldset>

      {error && <div className="alert alert-danger pre">{error}</div>}
      {!readOnly && (
        <div className="form-actions">
          <Button type="submit" variant="primary" busy={busy}>
            {mode === 'create' ? t('Create project') : t('Save')}
          </Button>
        </div>
      )}
    </form>
  );
}
