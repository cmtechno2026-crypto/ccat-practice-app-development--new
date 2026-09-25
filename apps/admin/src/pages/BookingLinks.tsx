import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// Parent Booking Links (Teacher Hub). An admin picks 1+ teachers and mints ONE shareable public link
// (served by TeachTime at `${base}/b/<token>`). The link automatically covers EVERY grade+subject the
// selected teacher(s) offer — the gateway fills the combos from ta_teachers.subjects, so there is no
// per-combo picker here.
interface TeacherRow { id: string; name: string; email: string; subjects: string[]; }
interface LinkRow {
  id: string; token: string; label: string | null; teacher_ids: string[]; grade: number; subject: string;
  combos: { subject: string; grade: number }[] | null;
  expires_at: string | null; is_active: boolean; created_by: string; created_by_name: string | null;
  created_at: string; status: string; pending_requests: number; total_requests: number; url: string | null;
}

const inp: React.CSSProperties = { padding: '8px 10px', border: '1px solid var(--line,#d7dce8)', borderRadius: 8, background: 'var(--card2,#f7f9fc)', color: 'inherit' };

const SUBJ_PALETTE = [
  { bg: '#f5edff', tx: '#7c3aed', bd: '#ddc9fb' }, { bg: '#fdf3e0', tx: '#b45309', bd: '#f7d9a8' },
  { bg: '#eef2ff', tx: '#4338ca', bd: '#c7d2fe' }, { bg: '#e8f4fd', tx: '#0369a1', bd: '#bae0fb' },
  { bg: '#fdeef2', tx: '#be123c', bd: '#fbcfe0' }, { bg: '#e2f6f3', tx: '#0f766e', bd: '#b7e6df' },
];
function subjColor(subject: string) { const k = String(subject || '').toLowerCase().trim(); let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return SUBJ_PALETTE[h % SUBJ_PALETTE.length]; }
const AV_GRADS = ['linear-gradient(135deg,#2f6fd0,#1e4e9e)', 'linear-gradient(135deg,#7c3aed,#5b21b6)', 'linear-gradient(135deg,#0f766e,#0b5a54)', 'linear-gradient(135deg,#d4620e,#b45309)', 'linear-gradient(135deg,#be123c,#9d174d)'];
function avGrad(name: string) { const k = String(name || ''); let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return AV_GRADS[h % AV_GRADS.length]; }
function initials(n: string) { return (n || '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?'; }
// Parse a teacher subjects[] entry like "Math (Grade 10)" into { subject, grade }.
function parseTeacherCombos(subjects: string[] | undefined): { subject: string; grade: number }[] {
  const out: { subject: string; grade: number }[] = [];
  (subjects || []).forEach(raw => {
    const m = /^(.*?)\s*\(\s*Grade\s*(\d{1,2})\s*\)\s*$/i.exec(String(raw || ''));
    if (m) { const sub = (m[1] || '').trim(); const g = Number(m[2]); if (sub && g >= 1 && g <= 12) out.push({ subject: sub, grade: g }); }
  });
  return out;
}

export function BookingLinks() {
  const { can } = useAuth();
  const canManage = can('teacher.slots.manage');
  const [teachers, setTeachers] = useState<TeacherRow[]>([]);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [label, setLabel] = useState('');
  const [neverExp, setNeverExp] = useState(false);
  const [days, setDays] = useState(14);
  const [preview, setPreview] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState('');
  const [fSearch, setFSearch] = useState('');
  const [fSubject, setFSubject] = useState('');
  const [fGrade, setFGrade] = useState('');
  const teacherMeta = useMemo(() => teachers.map(t => ({ ...t, combos: parseTeacherCombos(t.subjects) })), [teachers]);
  const allSubjects = useMemo(() => [...new Set(teacherMeta.flatMap(t => t.combos.map(c => c.subject)))].sort(), [teacherMeta]);
  const allGrades = useMemo(() => [...new Set(teacherMeta.flatMap(t => t.combos.map(c => c.grade)))].sort((a, b) => a - b), [teacherMeta]);
  const shownTeachers = useMemo(() => teacherMeta.filter(t => {
    if (fSearch && !((t.name || '').toLowerCase().includes(fSearch.toLowerCase()) || (t.email || '').toLowerCase().includes(fSearch.toLowerCase()))) return false;
    if (fSubject && !t.combos.some(c => c.subject === fSubject)) return false;
    if (fGrade && !t.combos.some(c => String(c.grade) === fGrade)) return false;
    return true;
  }), [teacherMeta, fSearch, fSubject, fGrade]);

  const loadLinks = () => { setLoading(true); api.teacherBookingLinks(filter).then(r => setLinks(r.links)).catch(e => setErr(e.message)).finally(() => setLoading(false)); };
  useEffect(() => { api.teacherTeachers().then(r => setTeachers(r.teachers)).catch(() => {}); }, []);
  useEffect(loadLinks, [filter]);

  const selKey = [...sel].sort().join(',');
  // Live count of available slots the link will surface (all of the selected teacher(s) combos).
  useEffect(() => {
    if (sel.size === 0) { setPreview(null); return; }
    const ids = [...sel];
    const t = setTimeout(() => { api.teacherBookingLinkPreview(ids).then(r => setPreview(r.available)).catch(() => setPreview(null)); }, 350);
    return () => clearTimeout(t);
  }, [selKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const create = async () => {
    if (sel.size === 0) return;
    setCreating(true); setErr('');
    try {
      await api.teacherCreateBookingLink({ teacher_ids: [...sel], label: label || undefined, never_expires: neverExp, expires_in_days: neverExp ? null : days });
      setSel(new Set()); setLabel(''); setPreview(null);
      loadLinks();
    } catch (e: any) { setErr(e.message); } finally { setCreating(false); }
  };

  const copy = async (url: string, id: string) => { try { await navigator.clipboard.writeText(url); setCopied(id); setTimeout(() => setCopied(''), 1500); } catch { /* clipboard blocked */ } };
  const setActive = async (id: string, active: boolean) => { try { await api.teacherPatchBookingLink(id, { action: active ? 'revoke' : 'activate' }); loadLinks(); } catch (e: any) { setErr(e.message); } };

  const statusChip = (st: string) => {
    const map: Record<string, [string, string]> = { active: ['var(--good,#0f9d6b)', 'var(--good-soft,#dcf5ea)'], expired: ['var(--amber,#b8860b)', '#fbf0d5'], revoked: ['var(--coral,#c0392b)', 'var(--coral-soft,#fdece9)'] };
    const [c, bg] = map[st] || ['var(--ink,#333)', '#eee'];
    return <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', padding: '2px 8px', borderRadius: 999, background: bg, color: c }}>{st}</span>;
  };
  const teacherName = (id: string) => teachers.find(t => t.id === id)?.name || id.slice(0, 8);
  // Per-subject grade lists for a link, from its combos.
  const subjectGrades = (l: LinkRow) => {
    const map = new Map<string, number[]>();
    (l.combos && l.combos.length ? l.combos : [{ subject: l.subject, grade: l.grade }]).forEach(c => {
      if (!map.has(c.subject)) map.set(c.subject, []);
      if (!map.get(c.subject)!.includes(c.grade)) map.get(c.subject)!.push(c.grade);
    });
    return [...map.entries()].map(([subject, grades]) => ({ subject, grades: grades.sort((a, b) => a - b) }));
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {canManage && (
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 }}>
          <h3 style={{ margin: '0 0 12px' }}>New booking link</h3>
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Teachers ({sel.size} selected) — the link covers every grade &amp; subject they teach</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <input value={fSearch} onChange={e => setFSearch(e.target.value)} placeholder="Search name or email…" style={{ ...inp, minWidth: 180, flex: '1 1 180px' }} />
                <select value={fSubject} onChange={e => setFSubject(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
                  <option value="">All subjects</option>
                  {allSubjects.map(sName => <option key={sName} value={sName}>{sName}</option>)}
                </select>
                <select value={fGrade} onChange={e => setFGrade(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
                  <option value="">All grades</option>
                  {allGrades.map(g => <option key={g} value={String(g)}>Grade {g}</option>)}
                </select>
                {(fSearch || fSubject || fGrade) && <button onClick={() => { setFSearch(''); setFSubject(''); setFGrade(''); }} style={{ ...inp, cursor: 'pointer', fontWeight: 700 }}>Clear</button>}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 220, overflow: 'auto' }}>
                {teachers.length === 0 ? <span className="muted">No teachers yet.</span>
                  : shownTeachers.length === 0 ? <span className="muted" style={{ fontSize: 13 }}>No teachers match the filter.</span>
                  : shownTeachers.map(t => {
                    const subs = [...new Set(t.combos.map(c => c.subject))];
                    return (
                    <button key={t.id} onClick={() => toggle(t.id)} style={{ ...inp, cursor: 'pointer', fontWeight: 700, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, border: sel.has(t.id) ? '2px solid var(--brand,#2f6fd0)' : inp.border, background: sel.has(t.id) ? 'var(--brand-soft,#e7f0fc)' : inp.background }}>
                      <span>{t.name}</span>
                      {subs.length > 0 && <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{subs.map(sName => { const c = subjColor(sName); return <span key={sName} style={{ fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.02em', padding: '1px 6px', borderRadius: 6, background: c.bg, color: c.tx, border: '1px solid ' + c.bd }}>{sName}</span>; })}</span>}
                    </button>
                    );
                  })}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ display: 'grid', gap: 4 }}><span className="muted" style={{ fontSize: 12 }}>Label (optional)</span>
                <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Internal note" style={{ ...inp, minWidth: 200 }} />
              </label>
              <label style={{ display: 'grid', gap: 4 }}><span className="muted" style={{ fontSize: 12 }}>Expiry</span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="number" min={1} max={365} value={days} disabled={neverExp} onChange={e => setDays(Number(e.target.value))} style={{ ...inp, width: 70, opacity: neverExp ? 0.5 : 1 }} />
                  <span className="muted" style={{ fontSize: 12 }}>days</span>
                  <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={neverExp} onChange={e => setNeverExp(e.target.checked)} />never</label>
                </span>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button onClick={create} disabled={creating || sel.size === 0} style={{ ...inp, cursor: 'pointer', fontWeight: 800, background: 'var(--brand,#2f6fd0)', color: '#fff', border: 'none', opacity: (creating || sel.size === 0) ? 0.6 : 1 }}>{creating ? 'Creating…' : 'Create link'}</button>
              {preview != null && <span className="muted" style={{ fontSize: 13 }}>{preview} available slot{preview === 1 ? '' : 's'} right now</span>}
            </div>
          </div>
        </section>
      )}

      <section>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
          {['all', 'active', 'expired', 'revoked'].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{ ...inp, cursor: 'pointer', fontWeight: 700, textTransform: 'capitalize', border: filter === f ? '2px solid var(--brand,#2f6fd0)' : inp.border }}>{f}</button>
          ))}
        </div>
        {err && <div className="empty" style={{ padding: 10, color: 'var(--coral,#c0392b)' }}>{err}</div>}
        {loading ? <div className="muted" style={{ padding: 12 }}>Loading…</div> : links.length === 0 ? <div className="muted" style={{ padding: 12 }}>No booking links.</div> : (
          <div style={{ display: 'grid', gap: 8 }}>
            {links.map(l => {
              const names = l.teacher_ids.map(teacherName);
              const first = names[0] || 'Teacher';
              const sg = subjectGrades(l);
              return (
              <div key={l.id} style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ width: 32, height: 32, borderRadius: '50%', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 12, flex: 'none', background: avGrad(first) }}>{initials(first)}</span>
                  <span style={{ fontWeight: 800, fontSize: 15 }}>{first}{names.length > 1 && <span className="muted" style={{ fontWeight: 600, fontSize: 12 }}> +{names.length - 1}</span>}</span>
                  {sg.map(x => { const c = subjColor(x.subject); return (
                    <span key={x.subject} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.02em', padding: '2px 10px', borderRadius: 8, background: c.bg, color: c.tx, border: '1px solid ' + c.bd }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.tx }} />{x.subject}
                    </span>
                  ); })}
                  {l.label && <span className="muted" style={{ fontSize: 12 }}>{l.label}</span>}
                  {statusChip(l.status)}
                  <span style={{ marginLeft: 'auto', fontSize: 12 }} className="muted">{l.pending_requests} pending · {l.total_requests} total</span>
                </div>
                <div style={{ margin: '10px 0 2px', marginLeft: 42, display: 'grid', gap: 4 }}>
                  {sg.map(x => { const c = subjColor(x.subject); return (
                    <div key={x.subject} style={{ fontSize: 13.5 }}><b style={{ color: c.tx }}>{x.subject}</b> &nbsp;<span className="muted" style={{ fontWeight: 600 }}>Grade :</span> <b>{x.grades.join(', ')}</b></div>
                  ); })}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, background: 'var(--card2,#f2f5fa)', border: '1px solid var(--line,#e6e9f0)', borderRadius: 8, padding: '6px 8px' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: l.url ? 'inherit' : 'var(--muted,#8a93a3)' }}>{l.url || ('/b/' + l.token)}</span>
                  <button onClick={() => copy(l.url || ('/b/' + l.token), l.id)} title="Copy link" aria-label="Copy link" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', borderRadius: 6, padding: '4px 8px', color: copied === l.id ? 'var(--good,#0f9d6b)' : 'inherit', fontWeight: 700, fontSize: 12 }}>
                    {copied === l.id
                      ? (<><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>Copied</>)
                      : (<><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>Copy</>)}
                  </button>
                </div>
                {!l.url && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Full shareable domain appears once TEACHTIME_PUBLIC_URL is set on the gateway.</div>}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {l.expires_at ? `Expires ${new Date(l.expires_at).toLocaleDateString()}` : 'No expiry'} · by {l.created_by_name || 'Admin'}
                  </span>
                  {canManage && <button onClick={() => setActive(l.id, l.is_active)} style={{ ...inp, cursor: 'pointer', fontWeight: 700, padding: '5px 10px', marginLeft: 'auto', color: l.is_active ? 'var(--coral,#c0392b)' : 'var(--good,#0f9d6b)' }}>{l.is_active ? 'Revoke' : 'Activate'}</button>}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
