import { useState } from 'react';
import { siteUrl } from '../../lib/format';
import { Badge, Button, Card, Copy, ErrorBox, Spinner } from '../../components/ui';
import { api, type DnsReport, type Meta, type Project, type WebhookStatus } from '../../lib/api';
import { usePoll } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { t } from '../../i18n';

const DNS_LABEL = {
  ok: { tone: 'success', text: 'OK' },
  missing: { tone: 'danger', text: 'no record' },
  mismatch: { tone: 'warning', text: 'points elsewhere' },
  unknown: { tone: 'neutral', text: 'resolved' },
} as const;

/** Nom de l'enregistrement à créer dans la zone DNS (approximation : zone = deux derniers libellés). */
function recordName(host: string): { zone: string; name: string } {
  const parts = host.split('.');
  const zone = parts.slice(-2).join('.');
  const name = parts.slice(0, -2).join('.') || '@';
  return { zone, name };
}

export function DomainsTab({ project, meta }: { project: Project; meta: Meta }) {
  const toast = useToast();
  const dns = usePoll(() => api<DnsReport>('GET', `/projects/${project.slug}/dns`), [project.slug]);
  const hook = usePoll(() => api<WebhookStatus>('GET', `/projects/${project.slug}/webhook`), [project.slug]);
  const [configuring, setConfiguring] = useState(false);

  const setupHook = async () => {
    setConfiguring(true);
    try {
      const r = await api<{ created: boolean }>('POST', `/projects/${project.slug}/webhook`);
      toast.success(r.created ? t('Webhook created on GitHub') : t('Webhook updated on GitHub'));
      await hook.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setConfiguring(false);
    }
  };

  const expected = dns.data?.expected.length ? dns.data.expected : meta.serverIps;

  return (
    <div className="stack">
      <Card>
        <div className="card-head">
          <div>
            <h2>{t('Domains')}</h2>
            <p className="muted small">
              {meta.siteScheme === 'http'
                ? t('Local mode: served over HTTP, without a certificate.')
                : t("Automatic HTTPS (Let's Encrypt) as soon as DNS points to the server.")}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void dns.reload()}>
            {t('Recheck DNS')}
          </Button>
        </div>
        {dns.loading && !dns.data ? (
          <Spinner label={t('Checking DNS…')} />
        ) : dns.error && !dns.data ? (
          <ErrorBox error={dns.error} onRetry={dns.reload} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Domain')}</th>
                  <th>DNS</th>
                  <th>{t('To set up at your registrar')}</th>
                </tr>
              </thead>
              <tbody>
                {dns.data!.hosts.map((h, i) => {
                  const { zone, name } = recordName(h.host);
                  const redirect = h.host.startsWith('www.') && !project.domains.includes(h.host);
                  return (
                    <tr key={h.host}>
                      <td>
                        <a className="mono" href={siteUrl(h.host)} target="_blank" rel="noreferrer">
                          {h.host}
                        </a>
                        <div className="row gap-sm small">
                          {i === 0 && <Badge tone="accent">{t('primary')}</Badge>}
                          {h.apex && <Badge>{t('apex domain')}</Badge>}
                          {redirect && <Badge tone="muted">{t('redirects to {host}', { host: h.host.slice(4) })}</Badge>}
                        </div>
                      </td>
                      <td>
                        <Badge tone={DNS_LABEL[h.status].tone}>{t(DNS_LABEL[h.status].text)}</Badge>
                        {h.ips.length > 0 && <div className="muted small mono">{h.ips.join(', ')}</div>}
                      </td>
                      <td className="small">
                        {h.status === 'ok' ? (
                          <span className="muted">{t('Nothing to do')}</span>
                        ) : (
                          <>
                            {t('Zone')} <span className="mono">{zone}</span>: {t('record')} <strong>A</strong>{' '}
                            <span className="mono">{name}</span> →{' '}
                            <span className="mono">{expected.join(', ') || t('server IP')}</span>
                            {!h.apex && name !== '@' && (
                              <div className="muted">
                                ({t('not needed if a wildcard')} <span className="mono">*.{zone}</span> {t('already points to the server')})
                              </div>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          {t('To change the domain (or switch to an apex domain), go to')} <strong>{t('Settings')}</strong>{t(', then redeploy.')}
          {dns.data?.hosts.some((h) => h.status === 'mismatch') &&
            ` ${t('"Points elsewhere" is expected if the domain goes through a proxy (Cloudflare) set up to reach this server.')}`}
        </p>
      </Card>

      <Card>
        <div className="card-head">
          <div>
            <h2>{t('GitHub webhook')}</h2>
            <p className="muted small">{t('Triggers a deployment on every push. Without a webhook, polling still checks regularly.')}</p>
          </div>
          {hook.data?.configured !== true && hook.data?.mode !== 'app' && (
            <Button size="sm" variant="primary" busy={configuring} onClick={() => void setupHook()}>
              {t('Set up automatically')}
            </Button>
          )}
        </div>
        {hook.loading && !hook.data ? (
          <Spinner />
        ) : hook.error && !hook.data ? (
          <ErrorBox error={hook.error} onRetry={hook.reload} />
        ) : hook.data?.mode === 'app' ? (
          hook.data.configured && meta.github.webhooks === false ? (
            <div className="row gap-sm wrap small">
              <Badge>polling</Badge>
              <span>
                {t("Catalyst runs locally: GitHub can't reach it, so new commits are detected every {n}s.", { n: meta.github.pollSeconds ?? 60 })}
              </span>
            </div>
          ) : hook.data.configured ? (
            <div className="row gap-sm wrap small">
              <Badge tone="success">{t('active')}</Badge>
              <span>{t('Managed by the GitHub App: every push to {branch} triggers a deployment. Nothing to set up.', { branch: project.branch })}</span>
            </div>
          ) : (
            <div className="stack-sm small">
              <div className="alert alert-warning">{t("The GitHub App can't access {repo}.", { repo: project.repo })}</div>
              {meta.github.installUrl && (
                <a className="btn btn-sm" href={meta.github.installUrl}>
                  {t('Give access to this repo ↗')}
                </a>
              )}
            </div>
          )
        ) : hook.data?.configured ? (
          <div className="stack-sm">
            <div className="row gap-sm wrap">
              <Badge tone={hook.data.active ? 'success' : 'warning'}>{hook.data.active ? t('active') : t('inactive')}</Badge>
              {hook.data.lastResponse?.code ? (
                <span className="small">
                  {t('Last delivery:')} <span className="mono">HTTP {hook.data.lastResponse.code}</span>{' '}
                  {hook.data.lastResponse.message && <span className="muted">{hook.data.lastResponse.message}</span>}
                </span>
              ) : (
                <span className="muted small">{t('No deliveries yet')}</span>
              )}
            </div>
            <Button size="sm" busy={configuring} onClick={() => void setupHook()}>
              {t('Set up again')}
            </Button>
          </div>
        ) : (
          <div className="stack-sm small">
            {hook.data?.error && <div className="alert alert-warning">{hook.data.error}</div>}
            <p>
              {t('Manual setup at')}{' '}
              <a href={`https://github.com/${project.repo}/settings/hooks/new`} target="_blank" rel="noreferrer">
                github.com/{project.repo} → Settings → Webhooks
              </a>{' '}
              :
            </p>
            <ul className="list">
              <li>
                Payload URL: <Copy value={hook.data?.url ?? meta.webhookUrl} />
              </li>
              <li>
                Content type: <span className="mono">application/json</span>
              </li>
              <li>
                Secret: {t('the value of')} <span className="mono">GITHUB_WEBHOOK_SECRET</span> ({t("server's .env file")})
              </li>
              <li>{t('Event:')} “Just the push event”</li>
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}
