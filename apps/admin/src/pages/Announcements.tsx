import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Modal, ErrorBox, useToast } from '../components/ui';

function text(blocks: any): string { return Array.isArray(blocks) ? blocks.map((b: any) => b?.value ?? '').join(' ') : ''; }
const fmt = (d: string) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Derived lifecycle label (mockup: Live / Scheduled / Stopped / Ended / Draft).
function lifecycle(a: any): { key: string; label: string; cls: string } {
  if (a.state === 'draft') return { key: 'draft', label: 'Draft', cls: 's-draft' };
  if (a.state === 'scheduled') return { key: 'scheduled', label: 'Scheduled', cls: 's-scheduled' };
  if (a.state === 'stopped') return { key: 'stopped', label: 'Stopped', cls: 's-stopped' };
  if (a.state === 'archived') return { key: 'ended', label: 'Ended', cls: 's-archived' };
  if (a.state === 'published') {
    if (a.ends_at && new Date(a.ends_at).getTime() < Date.now()) return { key: 'ended', label: 'Ended', cls: 's-archived' };
    return { key: 'live', label: 'Live', cls: 's-published' };
  }
  return { key: a.state, label: a.state, cls: '' };
}
const CHIPS = [{ k: '', l: 'All' }, { k: 'live', l: 'Live' }, { k: 'scheduled', l: 'Scheduled' }, { k: 'stopped', l: 'Stopped' }, { k: 'ended', l: 'Ended' }, { k: 'draft', l: 'Drafts' }];

export function Announcements() {
  const { can } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState<any>(null);
  const [grades, setGrades] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [create, setCreate] = useState(false);
  const [sched, setSched] = useState<{ id: string; mode: 'extend' | 'reschedule'; title: string } | null>(null);
  const [sortBy, setSortBy] = useState<'created' | 'title' | 'status'>('created');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const load = async () => { setError(null); try { setItems((await api.announcements()).items); } catch (e) { setError(e); } };
  useEffect(() => { load(); api.taxonomy().then(t => setGrades(t.grades)).catch(() => {}); }, []); // eslint-disable-line

  const act = async (fn: Promise<any>, m: string) => { try { await fn; toast(m); load(); } catch (e) { toast((e as Error).message); } };
  const withLc = (items ?? []).map(a => ({ ...a, lc: lifecycle(a) }));
  const shown = withLc.filter(a => !filter || a.lc.key === filter).sort((a, b) => {
    if (sortBy === 'title') return String(a.title).localeCompare(String(b.title));
    if (sortBy === 'status') return String(a.lc.label).localeCompare(String(b.lc.label));
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime(); // newest first
  });

  // KPIs (mockup): Live in carousel · Scheduled to send · Stopped by admin · With push.
  const k = {
    live: withLc.filter(a => a.lc.key === 'live').length,
    scheduled: withLc.filter(a => a.lc.key === 'scheduled').length,
    stopped: withLc.filter(a => a.lc.key === 'stopped').length,
    push: withLc.filter(a => a.channel === 'carousel_push').length,
  };
  const audience = (a: any) => {
    const g = a.target_grades?.length ? `${a.target_grades.length} grade${a.target_grades.length === 1 ? '' : 's'}` : 'All grades';
    const ch = a.channel === 'carousel_push' ? 'Carousel + push' : 'In-app carousel';
    return { g, ch, pushState: a.push_state };
  };
  const windowLabel = (a: any) => {
    const s = a.starts_at || a.scheduled_at || a.published_at;
    if (!s && !a.ends_at) return '—';
    return `${s ? 'Starts ' + fmt(s) : ''}${a.ends_at ? `${s ? ' · ' : ''}Ends ${fmt(a.ends_at)}` : ''}` || '—';
  };

  return (
    <div>
      <div className="toolbar">
        <div>
          <h2 style={{ fontSize: 22 }}>Announcements</h2>
          <p className="lead" style={{ marginBottom: 0 }}>Everything in the in-app carousel, and everything scheduled to go. Push bodies never carry a child's name or score.</p>
        </div>
        {can('announcement.manage') && <button className="btn" onClick={() => setCreate(true)}>+ New announcement</button>}
      </div>

      <div className="kpirow">
        <MiniKpi ico="📣" bg="var(--green-bg)" n={k.live} label="Live in the carousel" />
        <MiniKpi ico="⏱" bg="var(--tint)" n={k.scheduled} label="Scheduled to send" />
        <MiniKpi ico="⏸️" bg="var(--amber-bg)" n={k.stopped} label="Stopped by an admin" />
        <MiniKpi ico="🔔" bg="var(--lilac, #f0ebfa)" n={k.push} label="With a push channel" />
      </div>

      <div className="filterchips" style={{ display: 'flex', alignItems: 'center' }}>
        {CHIPS.map(s => <button key={s.k} className={`chipbtn ${filter === s.k ? 'on' : ''}`} onClick={() => setFilter(s.k)}>{s.l}</button>)}
        <span style={{ flex: 1 }} />
        <label className="muted" style={{ fontSize: 12, marginRight: 6 }}>Sort</label>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} aria-label="Sort announcements">
          <option value="created">Newest</option><option value="title">Title</option><option value="status">Status</option>
        </select>
      </div>

      {error ? <ErrorBox e={error} /> : (
        <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="tablewrap"><table>
            <thead><tr><th>Announcement</th><th>Audience</th><th>Status</th><th>Window</th><th className="right">Actions</th></tr></thead>
            <tbody>{shown.map(a => {
              const aud = audience(a);
              return (
                <tr key={a.id}>
                  <td><div style={{ fontWeight: 700, cursor: 'pointer' }} onClick={() => toggleExpand(a.id)}>{expanded.has(a.id) ? '▾' : '▸'} {a.title}</div><div className="muted" style={{ fontSize: 12, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text(a.body_blocks)}</div></td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{aud.g}<br /><span style={{ color: a.channel === 'carousel_push' ? 'var(--purple, #5b3fa8)' : 'var(--muted)' }}>{aud.ch}{aud.pushState ? ` · push ${aud.pushState}` : ''}</span></td>
                  <td><span className={`pill ${a.lc.cls}`} style={{ textTransform: 'none' }}>{a.lc.label}</span></td>
                  <td className="muted tabnum" style={{ fontSize: 12 }}>{windowLabel(a)}</td>
                  <td><div className="rowactions" style={{ justifyContent: 'flex-end' }}>
                    {(a.state === 'draft') && can('announcement.publish') && <button className="btn green sm" onClick={() => act(api.publishAnnouncement(a.id), 'Live now')}>Publish</button>}
                    {(a.state === 'draft' || a.state === 'scheduled' || a.state === 'published') && can('announcement.manage') && <button className="btn ghost sm" onClick={() => act(api.stopAnnouncement(a.id), 'Stopped')}>Stop</button>}
                    {a.state === 'stopped' && can('announcement.publish') && <button className="btn sm" onClick={() => act(api.restartAnnouncement(a.id), 'Restarted')}>Restart</button>}
                    {a.state === 'archived' && can('announcement.publish') && <button className="btn sm" onClick={() => act(api.restartAnnouncement(a.id), 'Running again')}>Run again</button>}
                    {a.state === 'published' && can('announcement.manage') && <button className="btn ghost sm" onClick={() => setSched({ id: a.id, mode: 'extend', title: a.title })}>Extend</button>}
                    {(a.state === 'scheduled' || a.state === 'draft' || a.state === 'stopped' || a.state === 'archived') && can('announcement.manage') && <button className="btn ghost sm" onClick={() => setSched({ id: a.id, mode: 'reschedule', title: a.title })}>Reschedule</button>}
                    {can('announcement.manage') && <button className="btn ghost sm" onClick={() => act(api.duplicateAnnouncement(a.id).then(() => {}), 'Duplicated as draft')}>Duplicate</button>}
                    {a.channel === 'carousel_push' && a.push_state === 'requested' && can('push.approve') && <button className="btn green sm" onClick={() => act(api.approvePush(a.push_campaign_id, 'approved'), 'Push approved')}>Approve push</button>}
                  </div></td>
                </tr>
              );
            }).flatMap((row, i) => {
              const a = shown[i];
              if (!expanded.has(a.id)) return [row];
              return [row, (
                <tr key={a.id + '-x'}><td colSpan={5} style={{ background: 'var(--tint, #f7faff)' }}>
                  <div style={{ padding: '4px 8px 10px' }}>
                    <div style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>{text(a.body_blocks) || <span className="muted">No body.</span>}</div>
                    <div className="muted" style={{ fontSize: 12.5, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                      <span><b>Channel:</b> {a.channel === 'carousel_push' ? 'In-app carousel + push' : 'In-app carousel'}</span>
                      <span><b>Audience:</b> {a.target_grades?.length ? `Grades ${a.target_grades.length}` : 'All grades'}</span>
                      {a.push_state && <span><b>Push:</b> {a.push_state}</span>}
                      {a.scheduled_at && <span><b>Scheduled:</b> {fmt(a.scheduled_at)}</span>}
                      {a.starts_at && <span><b>Started:</b> {fmt(a.starts_at)}</span>}
                      {a.ends_at && <span><b>Ends:</b> {fmt(a.ends_at)}</span>}
                      {a.published_at && <span><b>Published:</b> {fmt(a.published_at)}</span>}
                    </div>
                  </div>
                </td></tr>
              )];
            })}</tbody>
          </table></div>
          {items === null && <div className="empty">Loading…</div>}
          {items && shown.length === 0 && <div className="empty">Nothing here — switch the filter, or write a new announcement for the in-app carousel.</div>}
        </div>
      )}

      {sched && <ScheduleModal ctx={sched} onClose={() => setSched(null)} onSaved={() => { setSched(null); load(); }} />}
      {create && <Composer grades={grades} onClose={() => setCreate(false)} onSaved={() => { setCreate(false); load(); }} />}
    </div>
  );
}

function MiniKpi({ ico, bg, n, label }: { ico: string; bg: string; n: number; label: string }) {
  return <div className="kpi"><div className="ico" style={{ background: bg }}>{ico}</div><div><div className="n tabnum">{n}</div><div className="l">{label}</div></div></div>;
}

function Composer({ grades, onClose, onSaved }: { grades: any[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(''); const [body, setBody] = useState('');
  const [target, setTarget] = useState<Set<string>>(new Set());
  const [channel, setChannel] = useState<'carousel' | 'carousel_push'>('carousel');
  const [mode, setMode] = useState<'draft' | 'schedule'>('draft');
  const [when, setWhen] = useState(''); const [ends, setEnds] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const toggle = (id: string) => setTarget(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const save = async () => {
    if (!title.trim() || !body.trim()) { setErr('Title and body required'); return; }
    if (mode === 'schedule' && !when) { setErr('Pick a date & time to schedule'); return; }
    setBusy(true); setErr('');
    try {
      await api.createAnnouncement({
        title: title.trim(), body_text: body.trim(),
        target_grade_ids: target.size ? [...target] : undefined,
        channel,
        scheduled_at: mode === 'schedule' ? new Date(when).toISOString() : undefined,
        ends_at: ends ? new Date(ends).toISOString() : undefined,
      });
      toast(mode === 'schedule' ? 'Scheduled' : 'Draft created'); onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal wide title="New announcement" onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={save}>{mode === 'schedule' ? 'Schedule' : 'Save draft'}</button></>}>
      <label>Title</label><input value={title} onChange={e => setTitle(e.target.value)} />
      <label>Body</label><textarea rows={4} value={body} onChange={e => setBody(e.target.value)} placeholder="Shown in the in-app carousel." />
      <label>Channel</label>
      <div className="row">
        <label className={`pickrow ${channel === 'carousel' ? 'sel' : ''}`} style={{ flex: 1, margin: 0 }}><input type="radio" checked={channel === 'carousel'} onChange={() => setChannel('carousel')} /> In-app carousel</label>
        <label className={`pickrow ${channel === 'carousel_push' ? 'sel' : ''}`} style={{ flex: 1, margin: 0 }}><input type="radio" checked={channel === 'carousel_push'} onChange={() => setChannel('carousel_push')} /> Carousel + push</label>
      </div>
      {channel === 'carousel_push' && <p className="muted" style={{ fontSize: 12 }}>Push is queued for Super-Admin approval before it sends (§26.1). The body is checked for student PII — no merge fields like {'{{name}}'}.</p>}
      <label>Target grades (none = all)</label>
      <div className="row">{grades.map(g => (
        <label key={g.id} className={`pickrow ${target.has(g.id) ? 'sel' : ''}`} style={{ flex: '0 0 auto', margin: 0 }}>
          <input type="checkbox" checked={target.has(g.id)} onChange={() => toggle(g.id)} /> Grade {g.grade_number}
        </label>
      ))}</div>
      <label style={{ marginTop: 12 }}>Go live</label>
      <div className="row">
        <label className={`pickrow ${mode === 'draft' ? 'sel' : ''}`} style={{ flex: 1, margin: 0 }}><input type="radio" checked={mode === 'draft'} onChange={() => setMode('draft')} /> Save as draft</label>
        <label className={`pickrow ${mode === 'schedule' ? 'sel' : ''}`} style={{ flex: 1, margin: 0 }}><input type="radio" checked={mode === 'schedule'} onChange={() => setMode('schedule')} /> Schedule</label>
      </div>
      {mode === 'schedule' && <><label>Starts</label><input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></>}
      <label>Ends (optional)</label><input type="datetime-local" value={ends} onChange={e => setEnds(e.target.value)} />
      <div className="err">{err}</div>
    </Modal>
  );
}

function ScheduleModal({ ctx, onClose, onSaved }: { ctx: { id: string; mode: 'extend' | 'reschedule'; title: string }; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const isExtend = ctx.mode === 'extend';
  const save = async () => {
    if (!when) { setErr('Pick a date and time'); return; }
    const iso = new Date(when).toISOString();
    if (!isExtend && new Date(iso).getTime() <= Date.now()) { setErr('Scheduled time must be in the future'); return; }
    setBusy(true); setErr('');
    try {
      await api.patchAnnouncement(ctx.id, isExtend ? { ends_at: iso } : { scheduled_at: iso });
      toast(isExtend ? 'End time extended' : 'Rescheduled'); onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={`${isExtend ? 'Extend' : 'Reschedule'} — ${ctx.title}`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={save}>{isExtend ? 'Save new end time' : 'Save new start time'}</button></>}>
      <p className="lead">{isExtend ? 'Set a later end time — the announcement stays live until then.' : 'Pick a future start time — the announcement will publish automatically when due.'}</p>
      <label>{isExtend ? 'New end time' : 'New start time'}</label>
      <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} />
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}
