import { useEffect, useState, type ReactNode } from 'react';

/**
 * Icône d'un projet : le favicon du site déployé s'il en a un, sinon son initiale.
 * `version` (id du déploiement en ligne) force le rechargement après un nouveau déploiement.
 */
export function ProjectIcon({
  slug,
  version,
  className,
  children,
}: {
  slug: string;
  version: number | null | undefined;
  className: string;
  /** Superposition éventuelle (ex. point d'état de la sidebar). */
  children?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [slug, version]);
  const showFavicon = version != null && !failed;

  return (
    <span className={`${className}${showFavicon ? ' has-favicon' : ''}`} aria-hidden>
      {showFavicon ? (
        <img src={`/favicons/${slug}?v=${version}`} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        slug.slice(0, 1).toUpperCase()
      )}
      {children}
    </span>
  );
}
