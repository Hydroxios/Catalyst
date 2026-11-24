import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Project } from './api';
import { usePoll } from './hooks';

// --- Projets : une seule liste, partagée par la sidebar et le tableau de bord ---

interface ProjectsState {
  data: Project[] | null;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<void>;
}

const ProjectsContext = createContext<ProjectsState | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const projects = usePoll(() => api<Project[]>('GET', '/projects'), [], 4000);
  return <ProjectsContext.Provider value={projects}>{children}</ProjectsContext.Provider>;
}

export function useProjects(): ProjectsState {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error('ProjectsProvider manquant');
  return ctx;
}

// --- Fil d'Ariane : chaque page déclare où elle se trouve, la barre du haut l'affiche ---

export interface Crumb {
  label: string;
  href?: string;
}

const CrumbsContext = createContext<{ crumbs: Crumb[]; set: (c: Crumb[]) => void } | null>(null);

export function CrumbsProvider({ children }: { children: ReactNode }) {
  const [crumbs, set] = useState<Crumb[]>([]);
  return <CrumbsContext.Provider value={{ crumbs, set }}>{children}</CrumbsContext.Provider>;
}

export function useCrumbsValue(): Crumb[] {
  return useContext(CrumbsContext)?.crumbs ?? [];
}

/** À appeler dans chaque page : `useCrumbs([{ label: 'Projets', href: '#/' }, { label: slug }])`. */
export function useCrumbs(crumbs: Crumb[]): void {
  const ctx = useContext(CrumbsContext);
  const key = JSON.stringify(crumbs);
  useEffect(() => {
    ctx?.set(crumbs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
