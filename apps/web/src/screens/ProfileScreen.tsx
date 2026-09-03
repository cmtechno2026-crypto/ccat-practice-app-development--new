import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AccountInfo } from '@ccat/api-client';
import { useApp } from '../lib/store';
import { client } from '../lib/api';
import { AppBar, Card, Loader, ErrorNote, useAsync } from '../components/ui';
import { Avatar } from '../components/Avatar';

function NameEditor({ current, onSaved }: { current: string; onSaved: (n: string) => void }) {
  const { flash, refreshProfile } = useApp();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  async function save() {
    const v = value.trim();
    if (v.length < 1) { flash('Name cannot be empty.'); return; }
    setBusy(true);
    try { const r = await client.updateName(v); onSaved(r.display_name); await refreshProfile(); flash('Name updated'); setEditing(false); }
    catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  }
  if (!editing) {
    return (
      <Card onClick={() => { setValue(current); setEditing(true); }}>
        <div className="between"><div><h3>Name</h3><div className="muted">{current}</div></div><span className="pill">Edit</span></div>
      </Card>
    );
  }
  return (
    <Card>
      <div className="eyebrow">✏️ Edit name</div>
      <label className="field" style={{ marginTop: 8 }}>
        <span>Display name</span>
        <input className="input" value={value} maxLength={40} onChange={(e) => setValue(e.target.value)} />
      </label>
      <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn small secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        <button className="btn small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Card>
  );
}

function GuardianEditor({ account, onSaved }: { account: AccountInfo; onSaved: (g: NonNullable<AccountInfo['guardian']>) => void }) {
  const { flash } = useApp();
  const g = account.guardian;
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(g?.email ?? '');
  const [phone, setPhone] = useState(g?.phone ?? '');
  const [relationship, setRelationship] = useState(g?.relationship ?? '');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!email.trim() && !phone.trim()) { flash('A parent needs an email or a phone.'); return; }
    setBusy(true);
    try {
      // Guardian email is not editable here (recovery/OTP anchor) — send only phone + relationship.
      const r = await client.updateGuardian({ phone: phone.trim() || undefined, relationship: relationship.trim() || undefined });
      onSaved(r); flash('Parent updated'); setEditing(false);
    } catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  }
  if (!g) return <Card><div><h3>Parent</h3><div className="muted">No parent on file.</div></div></Card>;
  if (!editing) {
    return (
      <Card onClick={() => { setEmail(g.email ?? ''); setPhone(g.phone ?? ''); setRelationship(g.relationship ?? ''); setEditing(true); }}>
        <div className="between">
          <div><h3>Parent</h3><div className="muted">{g.email ?? g.phone ?? '—'}{g.relationship ? ` · ${g.relationship}` : ''}</div></div>
          <span className="pill">Edit</span>
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <div className="eyebrow">👪 Edit parent</div>
      <label className="field" style={{ marginTop: 8 }}><span>Email</span>
        <input className="input" type="email" value={email} readOnly disabled /></label>
      <div className="hint" style={{ marginTop: 6 }}>Parent email can't be changed here — it secures recovery. Contact support to change it.</div>
      <label className="field" style={{ marginTop: 10 }}><span>Phone</span>
        <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 000 0000" /></label>
      <label className="field" style={{ marginTop: 10 }}><span>Relationship</span>
        <select className="input" value={relationship} onChange={(e) => setRelationship(e.target.value)}>
          <option value="">Not specified</option>
          <option value="mother">Mother</option><option value="father">Father</option>
          <option value="grandparent">Grandparent</option><option value="other">Other</option>
        </select></label>
      <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn small secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        <button className="btn small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Card>
  );
}

function DeleteAccount() {
  const { flash, signOut } = useApp();
  const nav = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  async function del() {
    if (!ack) return;
    setBusy(true);
    try {
      const r = await client.deleteAccount();
      const days = r.restore_deadline ? Math.max(0, Math.ceil((new Date(r.restore_deadline).getTime() - Date.now()) / 86400000)) : 30;
      flash(`Account scheduled for deletion${r.reference ? ` (${r.reference})` : ''} — recoverable for ${days} days.`);
      await signOut();
      nav('/', { replace: true });
    } catch (e) { flash((e as Error).message); setBusy(false); }
  }
  return (
    <Card>
      <div className="eyebrow" style={{ color: 'var(--danger, #ef5b6b)' }}>⚠️ Delete account</div>
      {!confirming ? (
        <>
          <div className="muted" style={{ margin: '6px 0 10px' }}>This schedules your account for deletion. It stays recoverable for 30 days, then your personal data is erased.</div>
          <button className="btn small danger" onClick={() => setConfirming(true)}>Delete my account</button>
        </>
      ) : (
        <>
          <div className="muted" style={{ margin: '6px 0 10px' }}>You can undo this within 30 days by contacting support. After that it can't be reversed.</div>
          <label className="row" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>I understand my account will be scheduled for deletion.</span>
          </label>
          <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn small secondary" disabled={busy} onClick={() => { setConfirming(false); setAck(false); }}>Cancel</button>
            <button className="btn small danger" disabled={busy || !ack} onClick={del}>{busy ? 'Working…' : 'Confirm deletion'}</button>
          </div>
        </>
      )}
    </Card>
  );
}

export function ProfileScreen() {
  const nav = useNavigate();
  const { profile } = useApp();
  const { loading, error, data, reload } = useAsync(async () => client.account());
  const [name, setName] = useState<string | null>(null);
  const [guardian, setGuardian] = useState<AccountInfo['guardian'] | undefined>(undefined);

  const shownName = name ?? data?.display_name ?? profile?.display_name ?? '';
  const account: AccountInfo | null = data ? { ...data, display_name: shownName, guardian: guardian !== undefined ? guardian : data.guardian } : null;

  return (
    <>
      <AppBar title="My profile" sub="Account & security" back />
      <div className="content stack">
        <Card>
          <div className="row">
            <div className="avatar-chip" style={{ width: 56, height: 56 }}><Avatar size={40} /></div>
            <div style={{ flex: 1 }}>
              <h2>{shownName || profile?.display_name}</h2>
              <div className="muted">@{profile?.username} · Age {profile?.age_years}</div>
            </div>
          </div>
        </Card>

        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}

        {account && (
          <>
            <div className="eyebrow">Account</div>
            <NameEditor current={shownName} onSaved={setName} />
            <GuardianEditor account={account} onSaved={setGuardian} />
          </>
        )}

        {/* Security options temporarily hidden from users — re-enable later. The cards and their
            /recovery, /device, /referrals routes/handlers are kept in code (commented just below);
            only Help & Support renders. To re-enable, uncomment and restore the "Security" heading. */}
        <div className="eyebrow">Support</div>
        {/*
        <Card onClick={() => nav('/recovery')}><div className="between"><div><h3>Change / recover PIN</h3><div className="muted">Verify by parent OTP</div></div><span className="pill">›</span></div></Card>
        <Card onClick={() => nav('/device')}><div className="between"><div><h3>Move to a new device</h3><div className="muted">Re-enroll this browser</div></div><span className="pill">›</span></div></Card>
        <Card onClick={() => nav('/referrals')}><div className="between"><div><h3>Invite friends</h3><div className="muted">Share your code, earn coins</div></div><span className="pill">›</span></div></Card>
        */}
        <Card onClick={() => nav('/help')}><div className="between"><div><h3>Help & support</h3><div className="muted">FAQ & report a problem</div></div><span className="pill">›</span></div></Card>

        <div className="eyebrow">Danger zone</div>
        <DeleteAccount />
        <p className="hint">Data residency: Canada (PIPEDA). You can update or delete your data here anytime.</p>
      </div>
    </>
  );
}
