import { describe, expect, it } from 'vitest';
import { findFavicon, iconLinks, sniffImage } from '../src/favicon.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const ICO = Buffer.from([0, 0, 1, 0, 1, 0]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

/** Faux serveur : URL → réponse. */
function server(routes: Record<string, { type: string; body: Buffer | string; status?: number }>) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return { status: 404, type: 'text/plain', body: Buffer.from('') };
    return { status: r.status ?? 200, type: r.type, body: Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body) };
  };
  return { fetcher, calls };
}

describe('favicon', () => {
  it('reconnaît les formats d’image par leur contenu', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(ICO)).toBe('image/x-icon');
    expect(sniffImage(SVG)).toBe('image/svg+xml');
    expect(sniffImage(Buffer.from('<!doctype html><html>'))).toBeNull();
  });

  it('extrait les icônes d’une page, SVG en premier', () => {
    const html = `<head>
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel='shortcut icon' href='/favicon.png'>
      <link href="/icon.svg" rel="icon" type="image/svg+xml">
      <link rel="stylesheet" href="/style.css">
    </head>`;
    expect(iconLinks(html)).toEqual(['/icon.svg', '/favicon.png', '/apple.png']);
  });

  it('utilise l’icône déclarée dans la page', async () => {
    const base = 'http://10.0.0.5:3000';
    const { fetcher } = server({
      [`${base}/`]: { type: 'text/html; charset=utf-8', body: '<link rel="icon" href="/assets/logo.svg">' },
      [`${base}/assets/logo.svg`]: { type: 'image/svg+xml', body: SVG },
    });
    const icon = await findFavicon(base, ['mon-site.fr'], fetcher);
    expect(icon?.type).toBe('image/svg+xml');
  });

  it('passe par le conteneur pour un lien absolu vers le domaine du site', async () => {
    const base = 'http://10.0.0.5:3000';
    const { fetcher, calls } = server({
      [`${base}/`]: { type: 'text/html', body: '<link rel="icon" href="https://mon-site.fr/fav.png?v=2">' },
      [`${base}/fav.png?v=2`]: { type: 'image/png', body: PNG },
    });
    expect((await findFavicon(base, ['mon-site.fr'], fetcher))?.type).toBe('image/png');
    expect(calls).not.toContain('https://mon-site.fr/fav.png?v=2');
  });

  it('se rabat sur /favicon.ico et ignore une page HTML servie à la place de l’icône', async () => {
    const base = 'http://10.0.0.5:3000';
    const { fetcher } = server({
      [`${base}/`]: { type: 'text/html', body: '<link rel="icon" href="/missing.png">' },
      // SPA : renvoie index.html pour toute URL inconnue
      [`${base}/missing.png`]: { type: 'text/html', body: '<!doctype html>' },
      [`${base}/favicon.ico`]: { type: 'application/octet-stream', body: ICO },
    });
    expect((await findFavicon(base, [], fetcher))?.type).toBe('image/x-icon');
  });

  it('API sans page HTML ni favicon : rien', async () => {
    const base = 'http://10.0.0.5:8080';
    const { fetcher } = server({ [`${base}/`]: { type: 'application/json', body: '{"ok":true}' } });
    expect(await findFavicon(base, [], fetcher)).toBeNull();
  });

  it('accepte une icône en data URI', async () => {
    const base = 'http://10.0.0.5:3000';
    const uri = `data:image/png;base64,${PNG.toString('base64')}`;
    const { fetcher } = server({ [`${base}/`]: { type: 'text/html', body: `<link rel="icon" href="${uri}">` } });
    expect((await findFavicon(base, [], fetcher))?.type).toBe('image/png');
  });
});
