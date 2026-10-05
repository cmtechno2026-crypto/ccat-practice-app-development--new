import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

// Math Olympiad Support console (also serves CCAT when that workspace is active). Student "Report a
// problem" cases land in ccat.support_cases; staff read + reply via ccat.support_messages. Scoped to the
// active workspace by the X-Admin-Site header. Two panes: case list (left), thread + composer (right).
// Mirrors Support-Page mockup.
export function Support() {
  const [cases, setCases] = useState<any[]>([]);
  const [filter, setFilter] = useState<'open' | 'closed' | 'all'>('open');
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);

  const loadList = () => {
    api.supportCases(filter === 'all' ? undefined : filter)
      .then(r => setCases(r.items || []))
      .catch(e => setErr((e as Error).message));
  };
  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [filter]);

  const openCase = (id: string) => {
    setSelId(id); setDetail(null);
    api.supportCase(id).then(d => { setDetail(d); setTimeout(() => threadRef.current?.scrollTo(0, 1e9), 50); })
      .catch(e => setErr((e as Error).message));
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || !selId) return;
    setBusy(true); setErr('');
    try {
      await api.supportReply(selId, body); setDraft('');
      const d = await api.supportCase(selId); setDetail(d);
      setTimeout(() => threadRef.current?.scrollTo(0, 1e9), 50);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const setState = async (state: 'open' | 'resolved') => {
    if (!selId) return;
    try { await api.supportSetState(selId, state); const d = await api.supportCase(selId); setDetail(d); loadList(); }
    catch (e) { setErr((e as Error).message); }
  };

  const shown = cases.filter(c => {
    if (!q.trim()) return true;
    const s = `${c.student_name || ''} ${c.reference || ''} ${c.summary || ''}`.toLowerCase();
    return s.includes(q.trim().toLowerCase());
  });

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, height: 'calc(100vh - 150px)', minHeight: 420 }}>
      {/* LEFT — case list */}
      <div className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--line,#eef1f6)' }}>
          <div style={{ fontWeight: 800, marginBottom: 8 }}>Student messages</div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search students…"
            style={{ width: '100%', height: 36, borderRadius: 9, border: '1px solid var(--line,#e6eaf2)', padding: '0 10px', marginBottom: 8 }} />
          <div style={{ display: 'inline-flex', gap: 4, background: 'var(--card2,#eef2f7)', borderRadius: 8, padding: 3 }}>
            {(['open', 'closed', 'all'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                style={{ border: 0, background: filter === f ? 'var(--card,#fff)' : 'transparent', color: filter === f ? 'var(--primary,#1A5EAB)' : 'var(--muted,#647089)', fontWeight: 700, fontSize: 12, padding: '4px 11px', borderRadius: 6, cursor: 'pointer', textTransform: 'capitalize' }}>{f}</button>
            ))}
          </div>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {shown.length === 0 && <div className="muted" style={{ padding: 18 }}>No cases.</div>}
          {shown.map(c => (
            <button key={c.id} onClick={() => openCase(c.id)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 14px', background: selId === c.id ? 'var(--card2,#eef2f7)' : 'transparent', border: 0, borderBottom: '1px solid var(--line,#f1f3f8)', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 13.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.student_name || 'Unknown student'}</span>
                {c.state === 'closed' && <span style={{ fontSize: 10.5, fontWeight: 700, color: '#1b8a4b', background: '#e7f6ec', padding: '2px 7px', borderRadius: 999 }}>Resolved</span>}
              </div>
              <div className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.last_message || c.summary}</div>
              <div className="muted" style={{ fontSize: 11 }}>{c.reference}{c.grade_number ? ` · Grade ${c.grade_number}` : ''}</div>
            </button>
          ))}
        </div>
      </div>

      {/* RIGHT — thread */}
      <div className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!detail ? (
          <div className="muted" style={{ margin: 'auto', padding: 30 }}>Select a message to view the conversation.</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--line,#eef1f6)' }}>
              <div>
                <div style={{ fontWeight: 800 }}>{detail.student_name || 'Unknown student'}</div>
                <div className="muted" style={{ fontSize: 12 }}>{detail.reference}{detail.grade_number ? ` · Grade ${detail.grade_number}` : ''} · {detail.state === 'closed' ? 'Resolved' : 'Open'}</div>
              </div>
              <div style={{ flex: 1 }} />
              {detail.student_id && <Link className="btn ghost sm" to={`/students/${detail.student_id}`}>Open profile</Link>}
              {detail.state === 'closed'
                ? <button className="btn ghost sm" onClick={() => setState('open')}>Reopen</button>
                : <button className="btn ghost sm" onClick={() => setState('resolved')}>Mark resolved</button>}
            </div>
            <div ref={threadRef} style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg,#f7f9fc)' }}>
              <div className="muted" style={{ fontSize: 12.5, alignSelf: 'center' }}>{detail.summary}</div>
              {(detail.messages || []).map((m: any) => {
                const staff = m.sender === 'staff';
                return (
                  <div key={m.id} style={{ alignSelf: staff ? 'flex-end' : 'flex-start', maxWidth: '72%' }}>
                    <div style={{ background: staff ? 'var(--primary,#1A5EAB)' : 'var(--card,#fff)', color: staff ? '#fff' : 'var(--ink,#15233d)', border: staff ? 0 : '1px solid var(--line,#e6eaf2)', padding: '9px 13px', borderRadius: 12, fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{m.body}</div>
                    <div className="muted" style={{ fontSize: 10.5, textAlign: staff ? 'right' : 'left', marginTop: 3 }}>{staff ? 'Staff' : 'Student'} · {new Date(m.created_at).toLocaleString()}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--line,#eef1f6)' }}>
              <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Message the student…"
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                style={{ flex: 1, minWidth: 0, height: 44, borderRadius: 10, border: '1px solid var(--line,#e6eaf2)', padding: '0 14px' }} />
              <button className="btn" onClick={send} disabled={busy || !draft.trim()}>Send</button>
            </div>
          </>
        )}
        {err && <div className="err" style={{ padding: '6px 14px' }}>{err}</div>}
      </div>
    </div>
  );
}
