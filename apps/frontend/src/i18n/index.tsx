import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { fr } from './fr';

/**
 * Traductions de l'interface. Le texte anglais sert de clé (`t('Deploy now')`) ;
 * `fr.ts` donne la version française. Un texte absent du dictionnaire s'affiche en anglais.
 * Variables : `t('Stop {slug}?', { slug })`.
 */

export type Lang = 'en' | 'fr';
export const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'fr', label: 'Français', short: 'FR' },
];

const STORAGE_KEY = 'catalyst.lang';
const DICTS: Record<Lang, Record<string, string>> = { en: {}, fr };

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'fr') return saved;
  } catch {
    // stockage indisponible : langue par défaut
  }
  return 'en';
}

let current: Lang = initialLang();
const listeners = new Set<(l: Lang) => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // préférence non mémorisée
  }
  document.documentElement.lang = lang;
  listeners.forEach((l) => l(lang));
}

/** Traduit un texte anglais dans la langue courante et remplace les {variables}. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const out = (current === 'en' ? text : DICTS[current][text]) ?? text;
  if (!vars) return out;
  return out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Locale pour les dates (toLocaleString). */
export const dateLocale = () => (current === 'fr' ? 'fr-FR' : 'en-US');

/**
 * Remonte l'interface quand la langue change : tous les textes (y compris ceux calculés hors
 * composants, comme les dates relatives) sont recalculés sans recharger la page.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setState] = useState(current);
  useEffect(() => {
    document.documentElement.lang = current;
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return <Fragment key={lang}>{children}</Fragment>;
}

/** Sélecteur de langue (barre du haut, page de connexion). */
export function LanguageSwitcher({ className = '' }: { className?: string }) {
  return (
    <div className={`lang-switch ${className}`} role="group" aria-label={t('Language')}>
      {LANGS.map((l) => (
        <button
          key={l.id}
          type="button"
          className={l.id === current ? 'is-active' : ''}
          aria-pressed={l.id === current}
          title={l.label}
          onClick={() => setLang(l.id)}
        >
          {l.short}
        </button>
      ))}
    </div>
  );
}
