import React, { createContext, useContext, useState, useCallback } from 'react';

export function Panel({ title, right, children }: { title?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="panel">
      {(title || right) && <div className="toolbar">{title ? <h3>{title}</h3> : <span />}{right}</div>}
      {children}
    </div>
  );
}
export function Stat({ n, label, color }: { n: React.ReactNode; label: string; color?: string }) {
  return <div className="stat"><div className="n tabnum"><span className="dot" style={{ background: color || 'var(--primary)' }} />{n}</div><div className="l">{label}</div></div>;
}
export function Pill({ children, cls }: { children: React.ReactNode; cls?: string }) {
  return <span className={`pill dotted ${cls || ''}`}>{children}</span>;
}
export function StatusPill({ status }: { status: string }) {
  return <span className={`pill dotted s-${status} st-${status}`}>{status}</span>;
}
export function Empty({ children }: { children: React.ReactNode }) { return <div className="empty">{children}</div>; }

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
        {footer && <div className="row" style={{ marginTop: 16 }}>{footer}</div>}
      </div>
    </div>
  );
}

export function Loading() { return <div className="empty">Loading…</div>; }
export function ErrorBox({ e }: { e: any }) { return <div className="panel" style={{ color: 'var(--coral)' }}>{e?.message || String(e)}</div>; }

// ---- toast ----
const ToastCtx = createContext<(m: string) => void>(() => {});
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2200); }, []);
  return <ToastCtx.Provider value={show}>{children}<div className={`toast ${msg ? 'show' : ''}`}>{msg}</div></ToastCtx.Provider>;
}
export function useToast() { return useContext(ToastCtx); }

// data hook
export function useAsync<T>(fn: () => Promise<T>, deps: any[] = []): { data: T | null; error: any; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  React.useEffect(() => {
    let alive = true; setLoading(true); setError(null);
    fn().then(d => { if (alive) setData(d); }).catch(e => { if (alive) setError(e); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN(x => x + 1) };
}
