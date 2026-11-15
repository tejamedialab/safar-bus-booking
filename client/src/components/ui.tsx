import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api';
import { titleCase } from '../lib/format';

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="notice error" role="alert">
      <strong>{e.message ?? 'Something went wrong.'}</strong>
      {e.code === 'VALIDATION_ERROR' && Array.isArray(e.details) && (
        <ul className="small" style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
          {e.details.map((d: any) => (
            <li key={d.path + d.message}>
              {d.path ? <strong>{d.path}: </strong> : null}
              {d.message}
            </li>
          ))}
        </ul>
      )}
      <div className="row small muted" style={{ marginTop: '0.35rem' }}>
        {e.code && <span>Code {e.code}</span>}
        {e.requestId && <span>Ref {e.requestId.slice(0, 8)}</span>}
        {onRetry && (
          <button className="btn ghost small" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Skeleton({ h = 80, count = 1 }: { h?: number; count?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: h }} />
      ))}
    </div>
  );
}

export const Pill = ({ s }: { s: string }) => <span className={`pill ${s}`}>{titleCase(s)}</span>;

export function Pager({ meta, onPage }: { meta?: { page: number; totalPages: number; total: number }; onPage: (p: number) => void }) {
  if (!meta) return null;
  return (
    <nav className="pager" aria-label="Pagination">
      <span className="muted">
        {meta.total} result{meta.total === 1 ? '' : 's'} • page {meta.page} of {meta.totalPages}
      </span>
      <button className="btn secondary small" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>
        Previous
      </button>
      <button className="btn secondary small" disabled={meta.page >= meta.totalPages} onClick={() => onPage(meta.page + 1)}>
        Next
      </button>
    </nav>
  );
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="err">{error}</span>}
    </label>
  );
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="modal-title">
      <div className="panel-head">
        <h3 id="modal-title">{title}</h3>
        <button className="btn ghost small" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </dialog>
  );
}

const ToastCtx = createContext<(msg: string) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div aria-live="polite">{msg && <div className="toast">{msg}</div>}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
