import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { t } from '../i18n';

type Kind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  kind: Kind;
  message: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  show: (kind: Kind, message: string, action?: Toast['action']) => void;
  success: (message: string, action?: Toast['action']) => void;
  error: (err: unknown) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  const show = useCallback((kind: Kind, message: string, action?: Toast['action']) => {
    const id = nextId++;
    setToasts((t) => [...t.slice(-3), { id, kind, message, action }]);
    setTimeout(() => dismiss(id), kind === 'error' ? 9000 : action ? 8000 : 4000);
  }, []);
  const api: ToastApi = {
    show,
    success: (m, a) => show('success', m, a),
    error: (err) => show('error', err instanceof Error ? err.message : String(err)),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast toast-${item.kind}`}>
            <span>{item.message}</span>
            {item.action && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  item.action!.onClick();
                  dismiss(item.id);
                }}
              >
                {item.action.label}
              </button>
            )}
            <button className="toast-close" aria-label={t('Close')} onClick={() => dismiss(item.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('ToastProvider manquant');
  return ctx;
}
