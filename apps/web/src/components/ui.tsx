import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Grade } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { AvatarControl } from './AvatarControl';
import { resolveAssetUrl } from './Avatar';

// Grades rarely change, so load the list once per app session and reuse it to resolve the student's
// grade_id → a friendly "Grade N" label for the header pill (no gateway change; a small existing lookup).
let gradesPromise: Promise<Grade[]> | null = null;
function loadGrades(): Promise<Grade[]> {
  if (!gradesPromise) gradesPromise = client.grades().catch(() => [] as Grade[]);
  return gradesPromise;
}
function useGradeLabel(gradeId: string | null | undefined): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!gradeId) { setLabel(null); return; }
    loadGrades().then((gs) => {
      if (!alive) return;
      const g = gs.find((x) => x.id === gradeId);
      setLabel(g ? `Grade ${g.grade_number}` : null);
    });
    return () => { alive = false; };
  }, [gradeId]);
  return label;
}

// Reusable "🎓 Grade N" pill for any purple header — the shared AppBar AND the Home hero (which does not
// use AppBar). Renders nothing until the student's grade resolves.
export function GradePill() {
  const { profile } = useApp();
  const gradeLabel = useGradeLabel(profile?.grade_id);
  if (!profile || !gradeLabel) return null;
  return <span className="grade-pill">🎓 {gradeLabel}</span>;
}

// ---- content figures (question/option images) -----------------------------
// prompt_blocks / option content are block arrays: [{type:'text',value}, {type:'image',url,alt}, …].
// A question or option may carry an image block; extract its URL (given by the gateway — we don't build
// URLs, only resolve a gateway-relative path onto the gateway origin, exactly like avatars).
export interface BlockImage { url: string; alt: string }
export function imageFromBlocks(blocks: unknown): BlockImage | null {
  if (!Array.isArray(blocks)) return null;
  const b = blocks.find((x) => x && typeof x === 'object' && (x as { type?: string }).type === 'image' && (x as { url?: string }).url);
  return b ? { url: String((b as { url: string }).url), alt: String((b as { alt?: string }).alt ?? '') } : null;
}

// Bounded, lazy, SELF-HEALING content figure. Renders nothing when there's no image; on load-failure it
// hides itself (no broken-image icon, no layout jump) so the text stands alone. Used in Practice, Exam,
// and the bookmark review player so a question looks identical everywhere.
// Source order: the gateway's flat `url` (question.image_url / option.image_url) first; otherwise an image
// block inside `blocks` (the bookmark review payload carries blocks, not a flat url). URLs are used as
// given — we only resolve a gateway-relative path onto the gateway origin (same as avatars).
export function Figure({ url, blocks, kind, alt }: { url?: string | null; blocks?: unknown; kind: 'question' | 'option'; alt?: string }) {
  const [broken, setBroken] = useState(false);
  const fromBlock = blocks !== undefined ? imageFromBlocks(blocks) : null;
  const rawUrl = url || fromBlock?.url || null;
  const imgAlt = fromBlock?.alt || alt || (kind === 'question' ? 'Question figure' : 'Option image');
  if (broken || !rawUrl) return null;
  const src = resolveAssetUrl(rawUrl);
  if (!src) return null;
  return (
    <img
      className={kind === 'question' ? 'q-figure' : 'opt-figure'}
      src={src}
      loading="lazy"
      alt={imgAlt}
      onError={() => setBroken(true)}
    />
  );
}

export function AppBar({ title, sub, back, right, wide }: { title: string; sub?: string; back?: boolean; right?: React.ReactNode; wide?: boolean }) {
  const nav = useNavigate();
  const { profile } = useApp();
  return (
    <div className="appbar">
      {/* `wide` aligns the header's inner content to the same column as `.content-wide` pages (Progress),
          so Back sits hard-left and the avatar hard-right, in line with the page body. */}
      <div className={`inner${wide ? ' inner-wide' : ''}`}>
        {back && <button className="iconbtn" aria-label="Back" onClick={() => nav(-1)}>‹</button>}
        <div style={{ flex: 1 }}>
          <h1>{title}</h1>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {right}
        {/* Student's grade, resolved from grade_id → "Grade N", shown as a pill just left of the avatar. */}
        <GradePill />
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
