import { useCallback, useEffect, useRef, useState } from 'react';

interface Resource<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Charge une ressource et la rafraîchit toutes les `intervalMs` (pause quand l'onglet est caché). */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[], intervalMs = 0): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const gen = generation.current;
    try {
      const value = await loadRef.current();
      if (gen !== generation.current) return;
      setData(value);
      setError(null);
    } catch (err) {
      if (gen !== generation.current) return;
      setError(err as Error);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    generation.current++;
    setLoading(true);
    setData(null);
    void reload();
    if (!intervalMs) return;
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload };
}

/** Exécute une action async en exposant son état « en cours ». */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (...args: A) => {
      setBusy(true);
      try {
        await fn(...args);
      } finally {
        setBusy(false);
      }
    },
    [fn],
  );
  return [run, busy] as const;
}

/** Force un re-rendu périodique (temps relatifs « il y a 3 min »). */
export function useTick(ms = 15_000): void {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
