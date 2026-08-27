import React, { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync, Panel, StatusPill, Modal, Loading, ErrorBox, useToast } from '../components/ui';

type Bundle = { key: string; label: string; description: string; permissions: string[] };

export function Admins() {
  const toast = useToast();
  const { me } = useAuth();
  const { data, loading, error, reload } = useAsync(() => api.accounts());
  const perms = useAsync(() => api.permissions());
  const bundles = useAsync(() => api.permissionBundles());
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const [del, setDel] = useState<any | null>(null);

  const allPerms = (perms.data?.items || []).filter((p: any) => !p.super_admin_only);
  const allBundles: Bundle[] = bundles.data?.bundles || [];
  // Deletion is anonymize + tombstone (ADMIN-2). Hidden for yourself and for an admin who is still an
  // ACTIVE Super-Admin — the server refuses both; disable/demote a Super-Admin first.
  const canDelete = (a: any) => a.id !== me?.id && !(a.security_role === 'super_admin' && a.status === 'active');

  const toggleStatus = async (a: any) => { try { await api.patchAccount(a.id, { status: a.status === 'active' ? 'disabled' : 'active' }); toast('Updated'); reload(); } catch (e) { toast((e as Error).message); } };
  const resetPw = async (a: any) => { try { const r = await api.resetAccountPassword(a.id); setTemp({ email: a.email, password: r.temp_password }); reload(); } catch (e) { toast((e as Error).message); } };
  const unlock = async (a: any) => { try { const r = await api.unlockAccount(a.id); setTemp({ email: a.email, password: r.temp_password }); toast('Account unlocked'); reload(); } catch (e) { toast((e as Error).message); } };

  return (
    <>
      <h2>Admin Accounts</h2>
      <p className="lead">Provision admins with a one-time temporary password (§22.2). Grant access with permission bundles, then fine-tune. The last active Super-Admin is protected (§28.2).</p>
      <Panel right={<button className="btn sm" onClick={() => setEditing('new')}>+ New admin</button>}>
        {loading ? <Loading /> : error ? <ErrorBox e={error} /> : (
          <div className="tablewrap"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Permissions</th><th>MFA</th><th>Status</th><th></th></tr></thead>
            <tbody>{data!.items.map((a: any) => (
              <tr key={a.id}>
                <td style={{ fontWeight: 700 }}>{a.display_name}</td><td className="muted">{a.email}</td>
                <td>{a.security_role === 'super_admin' ? <span className="pill s-active">Super-Admin</span> : 'Admin'}</td>
                <td className="tabnum">{a.security_role === 'super_admin' ? 'all' : (a.permissions?.length || 0)}</td>
                <td>{a.mfa_enrolled ? '✓' : <span className="muted">no</span>}</td>
                <td><StatusPill status={a.status} />{a.locked && <span className="tag" style={{ marginLeft: 6, background: '#FDECE6', color: '#C2321C' }}>🔒 Locked</span>}</td>
                <td><div className="rowactions">
                  {a.locked && <button className="btn sm" onClick={() => unlock(a)}>Unlock</button>}
                  {a.security_role !== 'super_admin' && <button className="btn ghost sm" onClick={() => setEditing(a)}>Edit access</button>}
                  <button className="btn ghost sm" onClick={() => resetPw(a)}>Reset password</button>
                  <button className="btn ghost sm" onClick={() => toggleStatus(a)}>{a.status === 'active' ? 'Disable' : 'Enable'}</button>
                  {canDelete(a) && <button className="btn danger sm" onClick={() => setDel(a)}>Delete</button>}
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>

      {editing && <AdminEditor mode={editing === 'new' ? 'new' : 'edit'} admin={editing === 'new' ? null : editing}
        allPerms={allPerms} bundles={allBundles}
        onClose={() => setEditing(null)}
        onCreated={(email, password) => { setEditing(null); setTemp({ email, password }); reload(); }}
        onSaved={() => { setEditing(null); reload(); }} />}

      {temp && (
        <Modal title="Temporary password" onClose={() => setTemp(null)} footer={<button className="btn grow" onClick={() => setTemp(null)}>Done</button>}>
          <p>Share this one-time password with <b>{temp.email}</b>. It won't be shown again. They must change it and enrol MFA on first login.</p>
          <div className="panel" style={{ textAlign: 'center', fontFamily: 'monospace', fontSize: 18, margin: 0 }}>{temp.password}</div>
        </Modal>
      )}

      {del && <DeleteAdmin admin={del} onClose={() => setDel(null)} onDeleted={() => { setDel(null); toast('Admin deleted — PII erased; audit history retained.'); reload(); }} />}
    </>
  );
}

// Typed-confirm deletion (ADMIN-2). Requires typing the admin's email to arm the irreversible action.
function DeleteAdmin({ admin, onClose, onDeleted }: { admin: any; onClose: () => void; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState('');
  const [reference, setReference] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const armed = confirm.trim().toLowerCase() === String(admin.email).trim().toLowerCase();
  const doDelete = async () => {
    if (!armed) { setErr('Type the exact email to confirm'); return; }
    setBusy(true); setErr('');
    try { await api.deleteAccount(admin.id, reference.trim() || undefined); onDeleted(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Delete admin — ${admin.display_name}`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn danger grow" disabled={busy || !armed} onClick={doDelete}>{busy ? 'Deleting…' : 'Delete permanently'}</button></>}>
      <div className="aihint" style={{ background: 'var(--tint, #FDECE6)', color: '#C2321C' }}><b>Irreversible.</b> This erases the admin's identity (name, email, login credentials) and access grants, and tombstones the account as <b>deleted</b>. Their entries in the audit log are retained under an anonymized ID — the append-only audit trail is never rewritten (§36.3).</div>
      <label>Type <b>{admin.email}</b> to confirm</label>
      <input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={admin.email} autoFocus />
      <label>Legal / case reference (optional)</label>
      <input value={reference} onChange={e => setReference(e.target.value)} placeholder="e.g. CASE-1042" />
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}

function AdminEditor({ mode, admin, allPerms, bundles, onClose, onCreated, onSaved }: {
  mode: 'new' | 'edit'; admin: any | null; allPerms: any[]; bundles: Bundle[];
  onClose: () => void; onCreated: (email: string, password: string) => void; onSaved: () => void;
}) {
  const [email, setEmail] = useState(admin?.email || '');
  const [name, setName] = useState(admin?.display_name || '');
  const [role, setRole] = useState<string>(admin?.security_role || 'admin');
  const [sel, setSel] = useState<Set<string>>(new Set(admin?.permissions || []));
  const [verified, setVerified] = useState(false);
  const [tempPw, setTempPw] = useState('');
  const [recovery, setRecovery] = useState<'email' | 'phone'>('email');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const genPw = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 14; i++) s += a[Math.floor(Math.random() * a.length)]; setTempPw(s); };

  const has = (k: string) => sel.has(k);
  const toggle = (k: string) => setSel(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const bundleApplied = (b: Bundle) => b.permissions.length > 0 && b.permissions.every(p => sel.has(p));
  const toggleBundle = (b: Bundle) => setSel(s => {
    const n = new Set(s);
    if (b.permissions.every(p => n.has(p))) b.permissions.forEach(p => n.delete(p));
    else b.permissions.forEach(p => n.add(p));
    return n;
  });

  const save = async () => {
    if (mode === 'new' && (!email.trim() || !name.trim())) { setErr('Email and name required'); return; }
    if (mode === 'new' && !verified) { setErr('Confirm you have verified this person should have access to student data'); return; }
    if (mode === 'new' && tempPw && tempPw.length < 10) { setErr('Temporary password must be at least 10 characters (or leave blank to auto-generate)'); return; }
    setBusy(true); setErr('');
    try {
      if (mode === 'new') {
        const r = await api.createAccount({ email: email.trim(), display_name: name.trim(), role, permissions: role === 'admin' ? [...sel] : [], temp_password: tempPw || undefined, recovery_channel: recovery });
        onCreated(email.trim(), r.temp_password);
      } else {
        await api.patchAccount(admin.id, { role, permissions: role === 'admin' ? [...sel] : [] });
        onSaved();
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal wide title={mode === 'new' ? 'New admin account' : `Edit access — ${admin.display_name}`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={save}>{mode === 'new' ? 'Create' : 'Save'}</button></>}>
      {mode === 'new' && (
        <>
          <div className="infobox">The temporary password is shown once, here — they set their own after signing in. Five failed attempts locks the account, and only a Super-Admin can unlock it.</div>
          <label className="pickrow" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
            <input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} /> I have verified this person should have access to student data.
          </label>
          <div className="row">
            <div className="grow"><label>Full name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Riya Kapoor" /><div className="muted" style={{ fontSize: 12 }}>Shown in the audit log</div></div>
            <div className="grow"><label>Admin ID (work email)</label><input value={email} onChange={e => setEmail(e.target.value)} placeholder="name@conceptmastery.com" /><div className="muted" style={{ fontSize: 12 }}>Must be on the company domain</div></div>
          </div>
          <div className="row">
            <div className="grow"><label>Temporary password</label>
              <div style={{ display: 'flex', gap: 6 }}><input value={tempPw} onChange={e => setTempPw(e.target.value)} placeholder="At least 10 characters (or Generate)" /><button type="button" className="btn ghost sm" onClick={genPw}>Generate</button></div>
              <div className="muted" style={{ fontSize: 12 }}>Shown once; they set their own after signing in. Blank = auto-generate.</div>
            </div>
            <div className="grow"><label>Unlock code channel</label>
              <div className="filterchips" style={{ margin: 0 }}>
                <button type="button" className={`chipbtn ${recovery === 'email' ? 'on' : ''}`} onClick={() => setRecovery('email')}>Email</button>
                <button type="button" className={`chipbtn ${recovery === 'phone' ? 'on' : ''}`} onClick={() => setRecovery('phone')}>Phone</button>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>Only used when the account locks after 5 failed attempts</div>
            </div>
          </div>
        </>
      )}
      <label>Role</label>
      <div className="filterchips" style={{ margin: '0 0 6px' }}>
        <button type="button" className={`chipbtn ${role === 'admin' ? 'on' : ''}`} onClick={() => setRole('admin')}>admin</button>
        <button type="button" className={`chipbtn ${role === 'super_admin' ? 'on' : ''}`} onClick={() => setRole('super_admin')}>super_admin</button>
      </div>
      {role === 'super_admin'
        ? <p className="muted" style={{ fontSize: 12.5 }}>Super-Admin adds grade config, flags, admin lifecycle and push broadcast — every permission implicitly, no à-la-carte grants.</p>
        : <p className="muted" style={{ fontSize: 12.5 }}>Pick a bundle, then tick its permissions to fine-tune. The Audit log (own history) is available to every admin.</p>}
      {role === 'admin' && (
        <>
          <label>Permission bundles</label>
          <div className="filterchips">
            {bundles.map(b => (
              <button key={b.key} type="button" title={b.description}
                className={`chipbtn ${bundleApplied(b) ? 'on' : ''}`} onClick={() => toggleBundle(b)}>
                {bundleApplied(b) ? '✓ ' : ''}{b.label}
              </button>
            ))}
          </div>
          <label style={{ marginTop: 12 }}>Individual permissions ({sel.size} selected)</label>
          <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10, padding: 8 }}>
            {allPerms.map((p: any) => (
              <label key={p.key} style={{ display: 'flex', gap: 8, fontWeight: 500, margin: '4px 0', color: 'var(--ink-soft)' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={has(p.key)} onChange={() => toggle(p.key)} />
                {p.key}
              </label>
            ))}
          </div>
        </>
      )}
      <div className="err">{err}</div>
    </Modal>
  );
}
