import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from './icons';
import { Button } from './ui';
import { t } from '../i18n';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Fenêtre modale : focus piégé, Échap / clic à côté pour fermer, focus rendu à l'élément d'origine. */
export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  width = 480,
  busy = false,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Pendant une action en cours, on empêche la fermeture accidentelle. */
  busy?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const firstItem = items[0]!;
        const lastItem = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === firstItem) {
          e.preventDefault();
          lastItem.focus();
        } else if (!e.shiftKey && document.activeElement === lastItem) {
          e.preventDefault();
          firstItem.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panel}
        tabIndex={-1}
        style={{ maxWidth: width }}
      >
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <div className="modal-desc">{description}</div>}
          </div>
          <button type="button" className="sb-icon-btn" onClick={onClose} disabled={busy} aria-label={t('Close')}>
            <IconClose />
          </button>
        </header>
        {children && <div className="modal-body">{children}</div>}
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

// --- Confirmations et saisies, à la place de window.confirm / window.prompt ---

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** L'utilisateur doit retaper ce texte pour confirmer (actions irréversibles). */
  typeToConfirm?: string;
}

interface Dialogs {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const DialogContext = createContext<Dialogs | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setCurrent({ options, resolve })),
    [],
  );
  const close = (ok: boolean) => {
    current?.resolve(ok);
    setCurrent(null);
  };

  return (
    <DialogContext.Provider value={{ confirm }}>
      {children}
      {current && <ConfirmDialog options={current.options} onClose={close} />}
    </DialogContext.Provider>
  );
}

function ConfirmDialog({ options, onClose }: { options: ConfirmOptions; onClose: (ok: boolean) => void }) {
  const [typed, setTyped] = useState('');
  const canConfirm = !options.typeToConfirm || typed.trim() === options.typeToConfirm;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canConfirm) onClose(true);
  };

  return (
    <Modal title={options.title} onClose={() => onClose(false)} width={440}>
      <form className="stack" onSubmit={submit}>
        {options.message && <div className="modal-message">{options.message}</div>}
        {options.typeToConfirm && (
          <label className="field">
            <span className="field-label">
              {t('Type')} <span className="mono confirm-word">{options.typeToConfirm}</span> {t('to confirm')}
            </span>
            <input
              className="input mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              data-autofocus
            />
          </label>
        )}
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={() => onClose(false)}>
            {options.cancelLabel ?? t('Cancel')}
          </Button>
          <Button
            type="submit"
            variant={options.danger ? 'danger-solid' : 'primary'}
            disabled={!canConfirm}
            {...(options.typeToConfirm ? {} : { 'data-autofocus': true })}
          >
            {options.confirmLabel ?? t('Confirm')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function useDialog(): Dialogs {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('DialogProvider manquant');
  return ctx;
}
