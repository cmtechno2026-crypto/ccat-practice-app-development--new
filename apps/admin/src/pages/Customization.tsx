import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Modal, ErrorBox, useToast } from '../components/ui';
import { GamTabs } from '../components/GamTabs';

const STAGES = [1, 2, 3, 4, 5, 6, 7];

export function Customization() {
  const { can } = useAuth();
  const view: 'avatars' | 'themes' = useLocation().pathname.includes('themes') ? 'themes' : 'avatars';
  const toast = useToast();
  const canAvatar = can('avatar.manage');
  const canTheme = can('theme.manage');
  const [families, setFamilies] = useState<any[] | null>(null);
  const [themes, setThemes] = useState<any[] | null>(null);
  const [error, setError] = useState<any>(null);
  const [editing, setEditing] = useState<{ family: any; stage_number: number; stage?: any } | null>(null);
  const [newFamily, setNewFamily] = useState(false);
  const [editTheme, setEditTheme] = useState<any>(null);

  const load = async () => {
    setError(null);
    try {
      const [a, t] = await Promise.all([api.avatars(), api.themes()]);
      setFamilies(a.items); setThemes(t.items);
    } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const toggleFamily = async (f: any) => { try { await api.patchFamily(f.family_id, { active: !f.active }); load(); } catch (e) { toast((e as Error).message); } };
  const toggleTheme = async (t: any) => { try { await api.setThemeActive(t.id, !t.active); load(); } catch (e) { toast((e as Error).message); } };
  const makeDefault = async (t: any) => { try { await api.makeThemeDefault(t.id); toast(`${t.name} is now the brand default`); load(); } catch (e) { toast((e as Error).message); } };

  if (error) return <><GamTabs active={view} /><h2>Gamification</h2><ErrorBox e={error} /></>;

  return (
    <div>
      <GamTabs active={view} />
      <div className="toolbar">
        <div>
          <h2 style={{ fontSize: 22 }}>{view === 'themes' ? 'Themes' : 'Avatars 7×7'}</h2>
          <p className="lead" style={{ marginBottom: 0 }}>{view === 'themes'
            ? 'Screen themes children unlock with XP. A theme goes live to children when it is active.'
            : 'Seven categories × seven XP-gated stages, chosen by the child. A category only goes live when all seven stages are active; deactivating a stage keeps existing owners where they are.'}</p>
        </div>
        {view === 'avatars' && canAvatar && <button className="btn" onClick={() => setNewFamily(true)}>+ New family</button>}
      </div>

      {view === 'avatars' && (families === null ? <div className="empty">Loading…</div> : families.length === 0 ? <div className="panel"><div className="empty">No avatar families yet — create the first one.</div></div> : families.map(f => {
        const byNum: Record<number, any> = {};
        (f.stages || []).forEach((s: any) => { byNum[s.stage_number] = s; });
        return (
          <div className="famcard" key={f.family_id}>
            <div className="famhead">
              <h4>{f.family_name}</h4>
              <span className={`livepill ${f.live && f.active ? 'on' : 'off'}`}>{f.live && f.active ? 'Live' : `Draft · ${f.active_stages}/7 stages active`}</span>
              <span className="fmeta">👤 {f.owner_total} owners</span>
              <span className="spacerx" />
              {canAvatar && <>
                <span className="fmeta">Family {f.active ? 'on' : 'off'}</span>
                <button className={`toggle ${f.active ? 'on' : ''}`} onClick={() => toggleFamily(f)} aria-label="Toggle family" title={f.live ? '' : 'A family shows to children only when all 7 stages are active'} />
              </>}
            </div>
            <div className="agrid-wrap"><div className="agrid">
              {STAGES.map(n => {
                const s = byNum[n];
                if (!s) return (
                  <div key={n} className={`acell empty ${canAvatar ? '' : 'muted'}`} onClick={() => canAvatar && setEditing({ family: f, stage_number: n })}>
                    <div className="sx">Stage {n}</div>{canAvatar ? '+ Add' : '—'}
                  </div>
                );
                return (
                  <div key={n} className={`acell ${s.active ? 'on' : ''}`} onClick={() => canAvatar && setEditing({ family: f, stage_number: n, stage: s })}>
                    <div className="sx">Stage {n}</div>
                    <div className="xp tabnum">{s.required_xp != null ? `${s.required_xp} XP` : 'free'}</div>
                    <div className="st">{s.active ? 'Active' : 'Off'}</div>
                    <div className="ow">👤 {s.owner_count}</div>
                  </div>
                );
              })}
            </div></div>
          </div>
        );
      }))}

      {view === 'themes' && (
        <div className="panel">
          <div className="panelhead"><h3>Themes</h3></div>
          {themes === null ? <div className="empty">Loading…</div> : themes.length === 0 ? <div className="empty">No themes.</div> : (
            <div className="tablewrap"><table>
              <thead><tr><th>Theme</th><th>Key</th><th>Palette</th><th>Unlock rule</th><th className="right">Owners</th><th>Default</th><th>Active</th><th></th></tr></thead>
              <tbody>{themes.map(t => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 700 }}>{t.name}</td><td className="muted">{t.key}</td>
                  <td><div style={{ display: 'flex', gap: 4 }}>{Object.values(t.palette || {}).slice(0, 6).map((c: any, i: number) => <span key={i} title={String(c)} style={{ width: 16, height: 16, borderRadius: 4, background: String(c), border: '1px solid var(--line,#E1E7F4)' }} />)}{(!t.palette || Object.keys(t.palette).length === 0) && <span className="muted" style={{ fontSize: 12 }}>—</span>}</div></td>
                  <td>{t.rule?.type === 'default' ? 'Free' : t.rule?.type === 'xp_total' ? `Reach ${t.rule.threshold} XP` : (t.rule?.type || '—')}</td>
                  <td className="right tabnum">{t.owner_count}</td>
                  <td>{t.is_default ? <span className="pill s-active">Brand default</span> : (canTheme ? <button className="btn ghost sm" onClick={() => makeDefault(t)}>Make default</button> : <span className="muted">—</span>)}</td>
                  <td>{canTheme ? <button className={`toggle ${t.active ? 'on' : ''}`} onClick={() => toggleTheme(t)} aria-label="Toggle theme" /> : (t.active ? <span className="tag">active</span> : <span className="muted">off</span>)}</td>
                  <td>{canTheme && <button className="btn ghost sm" onClick={() => setEditTheme(t)}>Edit</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}

      {editing && <StageEditor ctx={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {newFamily && <FamilyCreate onClose={() => setNewFamily(false)} onSaved={() => { setNewFamily(false); load(); }} />}
      {editTheme && <ThemeEditor theme={editTheme} onClose={() => setEditTheme(null)} onSaved={() => { setEditTheme(null); load(); }} />}
    </div>
  );
}

const PALETTE_SLOTS = ['background', 'surface', 'primary', 'accent', 'text'];
function ThemeEditor({ theme, onClose, onSaved }: { theme: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(theme.name as string);
  const [palette, setPalette] = useState<Record<string, string>>(() => {
    const base: Record<string, string> = {};
    for (const k of PALETTE_SLOTS) base[k] = (theme.palette && theme.palette[k]) || '#EAF1FB';
    return { ...(theme.palette || {}), ...base };
  });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async () => {
    if (!name.trim()) { setErr('Name required'); return; }
    setBusy(true); setErr('');
    try { await api.editTheme(theme.id, { name: name.trim(), palette }); toast('Theme updated'); onSaved(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Edit theme — ${theme.name}`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={save}>Save</button></>}>
      <label>Theme name</label><input value={name} onChange={e => setName(e.target.value)} />
      <label style={{ marginTop: 10 }}>Palette</label>
      <p className="lead" style={{ marginTop: 0 }}>Keeps avatars legible on both light and dark themes.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 10 }}>
        {PALETTE_SLOTS.map(slot => (
          <div key={slot} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="color" value={palette[slot] || '#EAF1FB'} onChange={e => setPalette(p => ({ ...p, [slot]: e.target.value }))} style={{ width: 34, height: 34, padding: 0, border: 'none', background: 'none' }} aria-label={slot} />
            <div><div style={{ fontWeight: 700, fontSize: 12, textTransform: 'capitalize' }}>{slot}</div><div className="muted" style={{ fontSize: 11, fontFamily: 'ui-monospace,Menlo,monospace' }}>{palette[slot]}</div></div>
          </div>
        ))}
      </div>
      <div className="err">{err}</div>
    </Modal>
  );
}

function StageEditor({ ctx, onClose, onSaved }: { ctx: { family: any; stage_number: number; stage?: any }; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const isNew = !ctx.stage;
  const [name, setName] = useState(ctx.stage?.name ?? `${ctx.family.family_name} · Stage ${ctx.stage_number}`);
  const [xp, setXp] = useState(String(ctx.stage?.required_xp ?? [0, 50, 120, 220, 350, 520, 750][ctx.stage_number - 1]));
  const [active, setActive] = useState<boolean>(ctx.stage?.active ?? false);
  const [assetId, setAssetId] = useState<string | null>(ctx.stage?.asset_id ?? null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const fileRef = React.useRef<HTMLInputElement>(null);

  const onFile = async (file: File) => {
    setUploading(true); setErr('');
    try {
      const buf = await file.arrayBuffer();
      let bin = ''; const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = btoa(bin);
      const r = await api.uploadAsset(file.type, b64, `${ctx.family.family_name} stage ${ctx.stage_number}`);
      setAssetId(r.id);
      toast('Art uploaded');
    } catch (e) { setErr((e as Error).message); } finally { setUploading(false); }
  };
  const save = async () => {
    if (!name.trim()) { setErr('Name required'); return; }
    setBusy(true); setErr('');
    try {
      if (isNew) await api.createStage({ family_id: ctx.family.family_id, stage_number: ctx.stage_number, name: name.trim(), required_xp: Number(xp) || 0, active, asset_id: assetId ?? undefined });
      else await api.patchStage(ctx.stage.id, { name: name.trim(), required_xp: Number(xp) || 0, active, asset_id: assetId });
      toast(isNew ? 'Stage created' : 'Stage updated'); onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={`${ctx.family.family_name} · Stage ${ctx.stage_number}`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={save}>{isNew ? 'Create stage' : 'Save'}</button></>}>
      <label>Stage name</label><input value={name} onChange={e => setName(e.target.value)} />
      <label>Required XP (0 = free)</label><input type="number" min={0} value={xp} onChange={e => setXp(e.target.value)} />

      <label style={{ marginTop: 12 }}>Stage art</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 64, height: 64, borderRadius: 12, border: '1px solid var(--line, #E1E7F4)', display: 'grid', placeItems: 'center', overflow: 'hidden', background: 'var(--tint, #F4F6FC)' }}>
          {assetId ? <img src={api.assetUrl(assetId)} alt="stage art" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span className="muted" style={{ fontSize: 22 }}>🖼️</span>}
        </div>
        <div className="rowactions">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
          <button className="btn ghost sm" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? 'Uploading…' : 'Upload image'}</button>
          {assetId && <button className="btn ghost sm" onClick={() => setAssetId(null)}>Remove</button>}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <button className={`toggle ${active ? 'on' : ''}`} onClick={() => setActive(a => !a)} aria-label="Toggle active" />
        <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{active ? 'Active — visible to children (when the whole family is live)' : 'Off — hidden'}</span>
      </div>
      <div className="err">{err}</div>
    </Modal>
  );
}

function FamilyCreate({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState(''); const [name, setName] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async () => {
    if (!key.trim() || !name.trim()) { setErr('Key and name required'); return; }
    setBusy(true); setErr('');
    try { await api.createFamily(key.trim(), name.trim()); toast('Family created with 7 draft stages'); onSaved(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="New avatar family" onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={save}>Create</button></>}>
      <p className="lead">Creates the category with 7 draft stages on an XP ladder. Activate all seven to make it live.</p>
      <div className="row"><div className="grow"><label>Key</label><input value={key} onChange={e => setKey(e.target.value)} placeholder="e.g. owl" /></div>
        <div className="grow"><label>Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Owl" /></div></div>
      <div className="err">{err}</div>
    </Modal>
  );
}
