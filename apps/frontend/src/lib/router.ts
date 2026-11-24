import { useEffect, useState } from 'react';

/** Routage par hash (#/projects/x) : aucune config serveur nécessaire. */
export function currentPath(): string {
  return window.location.hash.replace(/^#/, '') || '/';
}

export function useRoute(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => {
      setPath(currentPath());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export const href = (path: string) => `#${path}`;

/** "/projects/:slug/:tab?" + "/projects/foo" → { slug: "foo" } */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('?')[0]!.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < Math.max(p.length, s.length); i++) {
    const seg = p[i];
    const value = s[i];
    if (seg === undefined) return null;
    const optional = seg.endsWith('?');
    if (seg.startsWith(':')) {
      if (value === undefined) {
        if (optional) continue;
        return null;
      }
      params[seg.replace(/^:|\?$/g, '')] = decodeURIComponent(value);
    } else if (seg !== value) {
      return null;
    }
  }
  return params;
}
