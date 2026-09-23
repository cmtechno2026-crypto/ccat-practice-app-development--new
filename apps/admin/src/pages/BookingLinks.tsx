import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// Parent Booking Links (Teacher Hub). An admin picks 1+ teachers, then one OR MORE of the (subject +
// grade) combinations those teachers actually offer, and mints ONE shareable public link (served by
// TeachTime at `${base}/b/<token>`) that surfaces the available slots across all chosen combos.
interface TeacherRow { id: string; name: string; email: string; subjects: string[]; }
interface Combo { subject: string; grade: number; label: string; key: string; }
interface LinkRow {
  id: string; token: string; label: string | null; teacher_ids: string[]; grade: number; subject: string;
  combos: { subject: string; grade: number }[] | null;
  expires_at: string | null; is_active: boolean; created_by: string; created_by_name: string | null;
  created_at: string; status: string; pending_requests: number; total_requests: number; url: string | null;
}

const inp: React.CSSProperties = { padding: '8px 10px', border: '1px solid var(--line,#d7dce8)', borderRadius: 8, background: 'var(--card2,#f7f9fc)', color: 'inherit' };

// Parse a teacher `subjects[]` entry like "Math (Grade 10)" into { subject, grade }.
function parseCombo(raw: string): { subject: string; grade: number } | null {
  const m = /^(.*?)\s*\(\s*Grade\s*(\d{1,2})\s*\)\s*$/i.exec(raw || '');
  if (!m) return null;
  const subject = (m[1] || '').trim();
  const grade = Number(m[2]);
  if (!subject || !(grade >= 1 && grade <= 12)) return null;
  return { subject, grade };
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
  const [selCombos, setSelCombos] = useState<Set<string>>(new Set());
  const [label, setLabel] = useState('');
  const [neverExp, setNeverExp] = useState(false);
  const [days, setDays] = useState(14);
  const [preview, setPreview] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState('');

  const loadLinks = () => { setLoading(true); api.teacherBookingLinks(filter).then(r => setLinks(r.links)).catch(e => setErr(e.message)).finally(() => setLoading(false)); };
  useEffect(() => { api.teacherTeachers().then(r => setTeachers(r.teachers)).catch(() => {}); }, []);
  useEffect(loadLinks, [filter]);

  // Union of the (subject + grade) combinations offered by the selected teachers, de-duplicated.
  const combos = useMemo<Combo[]>(() => {
    const map = new Map<string, Combo>();
    teachers.filter(t => sel.has(t.id)).forEach(t => (t.subjects || []).forEach(raw => {
      const c = parseCombo(raw);
      if (!c) return;
      const key = `${c.grade}|${c.subject}`;
      if (!map.has(key)) map.set(key, { ...c, key, label: `${c.subject} · Grade ${c.grade}` });
    }));
    return [...map.values()].sort((a, b) => a.grade - b.grade || a.subject.localeCompare(b.subject));
  }, [teachers, sel]);

  // Drop any chosen combo that is no longer offered by the current teacher selection.
  useEffect(() => {
    setSelCombos(prev => { const keep = new Set([...prev].filter(k => combos.some(c => c.key === k))); return keep.size === prev.size ? prev : keep; });
  }, [combos]);

  const chosen = combos.filter(c => selCombos.has(c.key));
  const chosenKey = chosen.map(c => c.key).join(',');

  useEffect(() => {
    if (sel.size === 0 || chosen.length === 0) { setPreview(null); return; }
    const ids = [...sel];
    const payload = chosen.map(c => ({ subject: c.subject, grade: c.grade }));
    const t = setTimeout(() => { api.teacherBookingLinkPreview(ids, payload).then(r => setPreview(r.available)).catch(() => setPreview(null)); }, 350);
    return () => clearTimeout(t);
  }, [sel, chosenKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleCombo = (key: string) => setSelCombos(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const allCombos = () => setSelCombos(new Set(combos.map(c => c.key)));

  const create = async () => {
    if (sel.size === 0 || chosen.length === 0) return;
    setCreating(true); setErr('');
    try {
      await api.teacherCreateBookingLink({ teacher_ids: [...sel], combos: chosen.map(c => ({ subject: c.subject, grade: c.grade })), label: label || undefined, never_expires: neverExp, expires_in_days: neverExp ? null : days });
      setSel(new Set()); setSelCombos(new Set()); setLabel(''); setPreview(null);
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
  const linkCombos = (l: LinkRow) => (l.combos && l.combos.length ? l.combos : [{ subject: l.subject, grade: l.grade }]).map(c => `${c.subject} · G${c.grade}`).join(', ');

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {canManage && (
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 }}>
          <h3 style={{ margin: '0 0 12px' }}>New booking link</h3>
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Teachers ({sel.size} selected)</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 150, overflow: 'auto' }}>
                {teachers.length === 0 ? <span className="muted">No teachers yet.</span> : teachers.map(t => (
                  <button key={t.id} onClick={() => toggle(t.id)} style={{ ...inp, cursor: 'pointer', fontWeight: 700, border: sel.has(t.id) ? '2px solid var(--brand,#2f6fd0)' : inp.border, background: sel.has(t.id) ? 'var(--brand-soft,#e7f0fc)' : inp.background }}>{t.name}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span className="muted" style={{ fontSize: 12 }}>Grade &amp; Subject ({selCombos.size} selected)</span>
                {combos.length > 1 && <button onClick={allCombos} style={{ ...inp, cursor: 'pointer', fontWeight: 700, padding: '2px 8px', fontSize: 12 }}>Select all</button>}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {sel.size === 0 ? <span className="muted" style={{ fontSize: 13 }}>Select teacher(s) first…</span>
                  : combos.length === 0 ? <span className="muted" style={{ fontSize: 13 }}>No grade+subject offerings for these teachers.</span>
                  : combos.map(c => (
                    <button key={c.key} onClick={() => toggleCombo(c.key)} style={{ ...inp, cursor: 'pointer', fontWeight: 700, border: selCombos.has(c.key) ? '2px solid var(--brand,#2f6fd0)' : inp.border, background: selCombos.has(c.key) ? 'var(--brand-soft,#e7f0fc)' : inp.background }}>{c.label}</button>
                  ))}
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
              <button onClick={create} disabled={creating || sel.size === 0 || chosen.length === 0} style={{ ...inp, cursor: 'pointer', fontWeight: 800, background: 'var(--brand,#2f6fd0)', color: '#fff', border: 'none', opacity: (creating || sel.size === 0 || chosen.length === 0) ? 0.6 : 1 }}>{creating ? 'Creating…' : 'Create link'}</button>
              {preview != null && <span className="muted" style={{ fontSize: 13 }}>{preview} available slot{preview === 1 ? '' : 's'} match right now</span>}
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
            {links.map(l => (
              <div key={l.id} style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 800 }}>{linkCombos(l)}</span>
                  {l.label && <span className="muted" style={{ fontSize: 12 }}>{l.label}</span>}
                  {statusChip(l.status)}
                  <span style={{ marginLeft: 'auto', fontSize: 12 }} className="muted">{l.pending_requests} pending · {l.total_requests} total</span>
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{l.teacher_ids.map(teacherName).join(', ')}</div>
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
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
