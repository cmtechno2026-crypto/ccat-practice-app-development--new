import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

// Math Olympiad Support console. LEFT: every Math student (or, for a teacher, only assigned students) —
// searchable, with last message + unread badge. RIGHT: the chat thread; staff can message ANY student
// (a case is created on first staff message). Matches the Support mockup (unread badges kept; the
// quick-action chips + INC tag are intentionally omitted).
const AVATAR_BG = ['#1A5EAB', '#0f766e', '#7c3aed', '#c0392b', '#E8A020', '#2f6fd0', '#b4356b', '#2a7d5f'];
function initials(name: string): string {
  return (name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function avatarColor(id: string): string {
  let h = 0; for (const c of id) h = (h + c.charCodeAt(0)) % AVATAR_BG.length;
  return AVATAR_BG[h];
}
function relTime(iso: string | null): string {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 172800) return 'Yesterday';
  return `${Math.floor(d / 86400)}d`;
}

export function Support() {
  const [students, setStudents] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);

  const loadList = () => {
    api.supportStudents().then(r => setStudents(r.items || [])).catch(e => setErr((e as Error).message));
  };
  useEffect(() => { loadList(); }, []);

  const openStudent = (sid: string) => {
    setSelId(sid); setDetail(null);
    api.supportThread(sid)
      .then(d => { setDetail(d); setTimeout(() => threadRef.current?.scrollTo(0, 1e9), 50); })
      .catch(e => setErr((e as Error).message));
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || !selId) return;
    setBusy(true); setErr('');
    try {
      await api.supportSend(selId, body); setDraft('');
      const d = await api.supportThread(selId); setDetail(d);
      loadList(); // refresh last-message + clears the unread badge (last message is now staff)
      setTimeout(() => threadRef.current?.scrollTo(0, 1e9), 50);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const shown = students.filter(s => {
    if (!q.trim()) return true;
    const t = `${s.student_name || ''} ${s.username || ''}`.toLowerCase();
    return t.includes(q.trim().toLowerCase());
  });

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, height: 'calc(100vh - 150px)', minHeight: 440 }}>
      {/* LEFT — student list */}
      <div className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: 14, borderBottom: '1px solid var(--line,#eef1f6)' }}>
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 10 }}>Student messages</div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search students…"
            style={{ width: '100%', height: 38, borderRadius: 10, border: '1px solid var(--line,#e6eaf2)', padding: '0 12px' }} />
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {shown.length === 0 && <div className="muted" style={{ padding: 18 }}>No students.</div>}
          {shown.map(s => {
            const on = selId === s.student_id;
            return (
              <button key={s.student_id} onClick={() => openStudent(s.student_id)}
                style={{ display: 'flex', gap: 11, alignItems: 'flex-start', width: '100%', textAlign: 'left', padding: '12px 14px', background: on ? 'var(--card2,#eef2f7)' : 'transparent', border: 0, borderBottom: '1px solid var(--line,#f1f3f8)', cursor: 'pointer' }}>
                <span style={{ flex: 'none', width: 40, height: 40, borderRadius: '50%', background: avatarColor(s.student_id), color: '#fff', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{initials(s.student_name)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.student_name}</span>
                    <span className="muted" style={{ fontSize: 11, flex: 'none' }}>{relTime(s.last_message_at)}</span>
                    {s.unread > 0 && <span style={{ flex: 'none', minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, background: '#E8A020', color: '#fff', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{s.unread}</span>}
                  </span>
                  <span className="muted" style={{ display: 'block', fontSize: 12 }}>Grade {s.grade_number} · Math Olympiad</span>
                  {s.last_message && <span className="muted" style={{ display: 'block', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.last_message}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* RIGHT — thread */}
      <div className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!detail ? (
          <div className="muted" style={{ margin: 'auto', padding: 30 }}>Select a message to view the conversation.</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid var(--line,#eef1f6)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{detail.student_name}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>Grade {detail.grade_number} · Math Olympiad</div>
              </div>
              {detail.student_id && <Link className="btn ghost sm" to={`/students/${detail.student_id}`}>Open profile</Link>}
            </div>
            <div ref={threadRef} style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--bg,#f7f9fc)' }}>
              {(detail.messages || []).length === 0 && (
                <div className="muted" style={{ fontSize: 12.5, alignSelf: 'center', textAlign: 'center' }}>
                  No messages yet. Send the first message to start the conversation.
                </div>
              )}
              {(detail.messages || []).map((m: any) => {
                const staff = m.sender === 'staff';
                return (
                  <div key={m.id} style={{ alignSelf: staff ? 'flex-end' : 'flex-start', maxWidth: '72%' }}>
                    <div style={{ background: staff ? 'var(--primary,#1A5EAB)' : 'var(--card,#fff)', color: staff ? '#fff' : 'var(--ink,#15233d)', border: staff ? 0 : '1px solid var(--line,#e6eaf2)', padding: '10px 14px', borderRadius: 14, fontSize: 14, whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{m.body}</div>
                    <div className="muted" style={{ fontSize: 11, textAlign: staff ? 'right' : 'left', marginTop: 4 }}>{staff ? 'You' : 'Student'} · {new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 10, padding: 14, borderTop: '1px solid var(--line,#eef1f6)' }}>
              <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Message the student…"
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                style={{ flex: 1, minWidth: 0, height: 46, borderRadius: 11, border: '1px solid var(--line,#e6eaf2)', padding: '0 15px' }} />
              <button className="btn" onClick={send} disabled={busy || !draft.trim()}>Send</button>
            </div>
          </>
        )}
        {err && <div className="err" style={{ padding: '6px 14px' }}>{err}</div>}
      </div>
    </div>
  );
}
