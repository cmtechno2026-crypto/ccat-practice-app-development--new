import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// Parent Booking Links (Teacher Hub). An admin picks 1+ teachers, then one of the (subject + grade)
// combinations those teachers actually offer, and mints a shareable public link (served by TeachTime
// at `${base}/b/<token>`). Parents open it, see the matching available slots, and submit a booking
// request that lands in the Requests inbox.
interface TeacherRow { id: string; name: string; email: string; subjects: string[]; }
interface Combo { subject: string; grade: number; label: string; key: string; }
interface LinkRow {
  id: string; token: string; label: string | null; teacher_ids: string[]; grade: number; subject: string;
  expires_at: string | null; is_active: boolean; created_by: string; created_by_name: string | null;
  created_at: string; status: string; pending_requests: number; total_requests: number; url: string | null;
}

const inp: React.CSSProperties = { padding: '8px 10px', border: '1px solid var(--line,#d7dce8)', borderRadius: 8, background: 'var(--card2,#f7f9fc)', color: 'inherit' };

// Parse a teacher `subjects[]` entry like "Math (Grade 10)" into { subject, grade }. Returns null when
// the entry has no "(Grade N)" part, since a booking link needs a concrete grade.
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
  const [comboKey, setComboKey] = useState('');
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

  // Keep the chosen combo valid as the teacher selection changes.
  useEffect(() => {
    if (comboKey && !combos.some(c => c.key === comboKey)) setComboKey('');
    else if (!comboKey && combos.length === 1) setComboKey(combos[0].key);
  }, [combos]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = combos.find(c => c.key === comboKey) || null;

  useEffect(() => {
    if (sel.size === 0 || !chosen) { setPreview(null); return; }
    const ids = [...sel];
    const t = setTimeout(() => { api.teacherBookingLinkPreview(ids, chosen.grade, chosen.subject).then(r => setPreview(r.available)).catch(() => setPreview(null)); }, 350);
    return () => clearTimeout(t);
  }, [sel, comboKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const create = async () => {
    if (sel.size === 0 || !chosen) return;
    setCreating(true); setErr('');
    try {
      await api.teacherCreateBookingLink({ teacher_ids: [...sel], grade: chosen.grade, subject: chosen.subject, label: label || undefined, never_expires: neverExp, expires_in_days: neverExp ? null : days });
      setSel(new Set()); setComboKey(''); setLabel(''); setPreview(null);
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
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ display: 'grid', gap: 4, minWidth: 240 }}><span className="muted" style={{ fontSize: 12 }}>Grade &amp; Subject</span>
                <select value={comboKey} onChange={e => setComboKey(e.target.value)} disabled={combos.length === 0} style={{ ...inp, opacity: combos.length === 0 ? 0.6 : 1 }}>
                  <option value="">{sel.size === 0 ? 'Select teacher(s) first…' : (combos.length === 0 ? 'No offerings for these teachers' : 'Select…')}</option>
                  {combos.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 4 }}><span className="muted" style={{ fontSize: 12 }}>Label (optional)</span>
                <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Internal note" style={{ ...inp, minWidth: 160 }} />
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
              <button onClick={create} disabled={creating || sel.size === 0 || !chosen} style={{ ...inp, cursor: 'pointer', fontWeight: 800, background: 'var(--brand,#2f6fd0)', color: '#fff', border: 'none', opacity: (creating || sel.size === 0 || !chosen) ? 0.6 : 1 }}>{creating ? 'Creating…' : 'Create link'}</button>
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
                  <span style={{ fontWeight: 800 }}>{l.subject} · G{l.grade}</span>
                  {l.label && <span className="muted" style={{ fontSize: 12 }}>{l.label}</span>}
                  {statusChip(l.status)}
                  <span style={{ marginLeft: 'auto', fontSize: 12 }} className="muted">{l.pending_requests} pending · {l.total_requests} total</span>
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{l.teacher_ids.map(teacherName).join(', ')}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  {l.url && <code style={{ fontSize: 12, background: 'var(--card2,#f2f5fa)', padding: '4px 8px', borderRadius: 6, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360, whiteSpace: 'nowrap' }}>{l.url}</code>}
                  {l.url && <button onClick={() => copy(l.url!, l.id)} style={{ ...inp, cursor: 'pointer', fontWeight: 700, padding: '5px 10px' }}>{copied === l.id ? 'Copied!' : 'Copy'}</button>}
                  <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                    {l.expires_at ? `Expires ${new Date(l.expires_at).toLocaleDateString()}` : 'No expiry'} · by {l.created_by_name || 'Admin'}
                  </span>
                  {canManage && <button onClick={() => setActive(l.id, l.is_active)} style={{ ...inp, cursor: 'pointer', fontWeight: 700, padding: '5px 10px', color: l.is_active ? 'var(--coral,#c0392b)' : 'var(--good,#0f9d6b)' }}>{l.is_active ? 'Revoke' : 'Activate'}</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
