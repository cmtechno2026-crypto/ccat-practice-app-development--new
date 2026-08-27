import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../lib/store';
import { AvatarControl } from './AvatarControl';

export function AppBar({ title, sub, back, right }: { title: string; sub?: string; back?: boolean; right?: React.ReactNode }) {
  const nav = useNavigate();
  const { profile } = useApp();
  return (
    <div className="appbar">
      <div className="inner">
        {back && <button className="iconbtn" aria-label="Back" onClick={() => nav(-1)}>‹</button>}
        <div style={{ flex: 1 }}>
          <h1>{title}</h1>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {right}
        {/* Top-right avatar is a control: opens the avatar + theme management panel. Only on in-app pages (has profile). */}
        {profile ? <AvatarControl /> : <div className="avatar-chip" aria-hidden>🦊</div>}
      </div>
    </div>
  );
}

export function Loader() { return <div className="spinner" role="status" aria-label="Loading" />; }

export function Toast() {
  const { toast } = useApp();
  if (!toast) return null;
  return <div className="toast" role="status">{toast}</div>;
}

export function Card({ children, onClick, className = '' }: { children: React.ReactNode; onClick?: () => void; className?: string }) {
  return <div className={`card ${onClick ? 'tap' : ''} ${className}`} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
    onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}>{children}</div>;
}

export function Field({ label, hint, hintKind, children }: { label: string; hint?: string; hintKind?: 'ok' | 'bad'; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className={`hint ${hintKind ?? ''}`}>{hint}</div>}
    </div>
  );
}

// A tiny data-loading hook to keep screens declarative: run(), loading/error/data states.
export function useAsync<T>(fn: () => Promise<T>, deps: React.DependencyList = []) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: T | null }>({ loading: true, error: null, data: null });
  const reload = React.useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then((data) => setState({ loading: false, error: null, data }))
      .catch((e) => setState({ loading: false, error: e?.message ?? 'Something went wrong', data: null }));
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="err" role="alert">
      {error}
      {onRetry && <button className="btn small ghost" style={{ marginLeft: 8 }} onClick={onRetry}>Retry</button>}
    </div>
  );
}
