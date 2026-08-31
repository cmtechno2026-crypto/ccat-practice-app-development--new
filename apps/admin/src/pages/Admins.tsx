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
  const [reset, setReset] = useState<any | null>(null);
  const isSuper = me?.role === 'super_admin';

  const allPerms = (perms.data?.items || []).filter((p: any) => !p.super_admin_only);
  const allBundles: Bundle[] = bundles.data?.bundles || [];
  // Deletion is anonymize + tombstone (ADMIN-2). Hidden for yourself and for an admin who is still an
  // ACTIVE Super-Admin — the server refuses both; disable/demote a Super-Admin first.
  const canDelete = (a: any) => a.id !== me?.id && !(a.security_role === 'super_admin' && a.status === 'active');

  const toggleStatus = async (a: any) => { try { await api.patchAccount(a.id, { status: a.status === 'active' ? 'disabled' : 'active' }); toast('Updated'); reload(); } catch (e) { toast((e as Error).message); } };
  const unlock = async (a: any) => { try { const r = await api.unlockAccount(a.id); setTemp({ email: a.email, password: r.temp_password }); toast('Account unlocked'); reload(); } catch (e) { toast((e as Error).message); } };

  return (
    <>
      <h2>Admin Accounts</h2>
      <p className="lead">Provision admins with a permanent password you set (§22.2). Grant access with permission bundles, then fine-tune. The last active Super-Admin is protected (§28.2).</p>
      <Panel right={<button className="btn sm" onClick={() => setEditing('new')}>+ New admin</button>}>
        {loading ? <Loading /> : error ? <ErrorBox e={error} /> : (
          <div className="tablewrap"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Permissions</th><th>Status</th><th></th></tr></thead>
            <tbody>{data!.items.map((a: any) => (
              <tr key={a.id}>
                <td style={{ fontWeight: 700 }}>{a.display_name}</td><td className="muted">{a.email}</td>
                <td>{a.security_role === 'super_admin' ? <span className="pill s-active">Super-Admin</span> : 'Admin'}</td>
                <td className="tabnum">{a.security_role === 'super_admin' ? 'all' : (a.permissions?.length || 0)}</td>
                <td><StatusPill status={a.status} />{a.locked && <span className="tag" style={{ marginLeft: 6, background: '#FDECE6', color: '#C2321C' }}>🔒 Locked</span>}</td>
                <td><div className="rowactions">
                  {a.locked && <button className="btn sm" onClick={() => unlock(a)}>Unlock</button>}
                  {a.security_role !== 'super_admin' && <button className="btn ghost sm" onClick={() => setEditing(a)}>Edit access</button>}
                  {isSuper && <button className="btn ghost sm" onClick={() => setReset(a)}>Reset password</button>}
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
        <Modal title="Password" onClose={() => setTemp(null)} footer={<button className="btn grow" onClick={() => setTemp(null)}>Done</button>}>
          <p>Share this password with <b>{temp.email}</b> securely. It won't be shown again — it is their permanent password and they sign in with it.</p>
          <div className="panel" style={{ textAlign: 'center', fontFamily: 'monospace', fontSize: 18, margin: 0 }}>{temp.password}</div>
        </Modal>
      )}

      {reset && <ResetPassword admin={reset} onClose={() => setReset(null)} onDone={(msg) => { setReset(null); toast(msg); reload(); }} />}

      {del && <DeleteAdmin admin={del} onClose={() => setDel(null)} onDeleted={() => { setDel(null); toast('Admin deleted — PII erased; audit history retained.'); reload(); }} />}
    </>
  );
}

// Super-Admin password reset for an admin account — GENERATE a strong one-time password, or SET one by
// typing New + Confirm (no old password required). Server enforces super_admin RBAC + strength; this is
// the convenience layer. The plaintext lives only in the form/generated field and is never persisted.
const MIN_LEN = 10;
function ResetPassword({ admin, onClose, onDone }: { admin: any; onClose: () => void; onDone: (msg: string) => void }) {
  const [mode, setMode] = useState<'choose' | 'generate' | 'set'>('choose');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [requireChange, setRequireChange] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const email = admin.email as string;
  const setValid = newPw.length >= MIN_LEN && newPw === confirm && newPw.trim().toLowerCase() !== String(email).trim().toLowerCase();

  const doGenerate = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.resetAccountPassword(admin.id, {});
      if (r.mode === 'generated') setGenerated(r.password);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const doSet = async () => {
    if (!setValid) return;
    setBusy(true); setErr('');
    try { await api.resetAccountPassword(admin.id, { new_password: newPw, require_change: requireChange }); onDone(`Password updated for ${email}.`); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(generated!); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } };

  const warning = <div className="infobox">Reset the password for <b>{email}</b>? Their current password stops working immediately (any signed-in session expires shortly).</div>;

  // Result screen after GENERATE — show once, copyable.
  if (generated) {
    return (
      <Modal title="New password" onClose={onClose} footer={<button className="btn grow" onClick={() => onDone(`Password reset for ${email}.`)}>Done</button>}>
        <p>Share this one-time password with <b>{email}</b> securely — it won't be shown again. They must change it on next login.</p>
        <div style={{ display: 'flex', gap: 6 }}>
          <input readOnly value={generated} style={{ fontFamily: 'ui-monospace,monospace', fontSize: 15 }} onFocus={e => e.currentTarget.select()} />
          <button className="btn ghost sm" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Reset password — ${admin.display_name}`} onClose={onClose}
      footer={mode === 'choose'
        ? <button className="btn ghost grow" onClick={onClose}>Cancel</button>
        : <>
            <button className="btn ghost grow" onClick={() => { setMode('choose'); setErr(''); }}>Back</button>
            {mode === 'generate'
              ? <button className="btn grow" disabled={busy} onClick={doGenerate}>{busy ? 'Resetting…' : 'Generate & reset'}</button>
              : <button className="btn grow" disabled={busy || !setValid} onClick={doSet}>{busy ? 'Saving…' : 'Reset password'}</button>}
          </>}>
      {warning}
      {mode === 'choose' && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn ghost grow" onClick={() => { setMode('generate'); setErr(''); }}>Generate new password</button>
          <button className="btn ghost grow" onClick={() => { setMode('set'); setErr(''); }}>Set a new password</button>
        </div>
      )}
      {mode === 'generate' && (
        <p className="muted" style={{ fontSize: 12.5 }}>A strong one-time password is generated and shown once. The admin must change it on next login.</p>
      )}
      {mode === 'set' && (
        <>
          <label>New password</label>
          <input type="password" value={newPw} autoComplete="new-password" onChange={e => setNewPw(e.target.value)} placeholder={`At least ${MIN_LEN} characters`} />
          <label>Confirm password</label>
          <input type="password" value={confirm} autoComplete="new-password" onChange={e => setConfirm(e.target.value)} placeholder="Re-enter the password" />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {newPw && newPw.length < MIN_LEN ? `Too short — at least ${MIN_LEN} characters.`
              : newPw && confirm && newPw !== confirm ? 'Passwords do not match.'
              : newPw && newPw.trim().toLowerCase() === String(email).trim().toLowerCase() ? 'Password must not be the email.'
              : 'This becomes the admin\'s password immediately.'}
          </div>
          <label className="pickrow" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 0' }}>
            <input type="checkbox" checked={requireChange} onChange={e => setRequireChange(e.target.checked)} /> Require this admin to change it on next login
          </label>
        </>
      )}
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
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
    if (mode === 'new' && tempPw && tempPw.length < 10) { setErr('Password must be at least 10 characters (or leave blank to auto-generate)'); return; }
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
          <div className="infobox">The password you set is shown once, here — it is the admin's permanent password (no first-login change, no MFA). Five failed attempts locks the account, and only a Super-Admin can unlock it.</div>
          <label className="pickrow" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
            <input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} /> I have verified this person should have access to student data.
          </label>
          <div className="row">
            <div className="grow"><label>Full name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Riya Kapoor" /><div className="muted" style={{ fontSize: 12 }}>Shown in the audit log</div></div>
            <div className="grow"><label>Admin ID (work email)</label><input value={email} onChange={e => setEmail(e.target.value)} placeholder="name@conceptmastery.com" /><div className="muted" style={{ fontSize: 12 }}>Must be on the company domain</div></div>
          </div>
          <div className="row">
            <div className="grow"><label>Password</label>
              <div style={{ display: 'flex', gap: 6 }}><input value={tempPw} onChange={e => setTempPw(e.target.value)} placeholder="At least 10 characters (or Generate)" /><button type="button" className="btn ghost sm" onClick={genPw}>Generate</button></div>
              <div className="muted" style={{ fontSize: 12 }}>Shown once. This becomes the admin's permanent password. Blank = auto-generate a strong one.</div>
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
