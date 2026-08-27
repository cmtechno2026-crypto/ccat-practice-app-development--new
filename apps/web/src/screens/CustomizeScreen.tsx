import { useState } from 'react';
import { ApiError } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Card, Loader, ErrorNote, useAsync } from '../components/ui';

export function CustomizeScreen() {
  const { flash, refreshProfile } = useApp();
  const [tab, setTab] = useState<'avatar' | 'theme'>('avatar');
  const { loading, error, data, reload } = useAsync(async () => {
    const [avatars, themes] = await Promise.all([client.avatars(), client.themes()]);
    return { avatars, themes };
  });
  const [busy, setBusy] = useState<string | null>(null);

  async function equipAvatar(stageId: string, owned: boolean, requiredXp: number | null) {
    setBusy(stageId);
    try { await client.equipAvatar(stageId); await refreshProfile(); flash('Avatar equipped!'); reload(); }
    catch (e) { flash(e instanceof ApiError && e.code === 'NOT_OWNED' ? `Locked — reach ${requiredXp ?? ''} XP to unlock.` : (e as Error).message); }
    finally { setBusy(null); }
  }
  async function equipTheme(themeId: string) {
    setBusy(themeId);
    try { await client.equipTheme(themeId); await refreshProfile(); flash('Theme applied!'); reload(); }
    catch (e) { flash(e instanceof ApiError && e.code === 'NOT_OWNED' ? 'Locked — keep practising to unlock.' : (e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <>
      <AppBar title="Customize" sub="Avatars & themes" back />
      <div className="content stack">
        <div className="row">
          <button className={`btn small ${tab === 'avatar' ? '' : 'secondary'}`} onClick={() => setTab('avatar')}>🦊 Avatar</button>
          <button className={`btn small ${tab === 'theme' ? '' : 'secondary'}`} onClick={() => setTab('theme')}>🎨 Themes</button>
        </div>
        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}
        {data && tab === 'avatar' && (
          <>
            <div className="muted">You have {data.avatars.xp_total} XP. Unlocked stages equip instantly; locked ones show the XP needed.</div>
            {data.avatars.families.map((fam) => (
              <Card key={fam.family_id}>
                <h3>{fam.name}</h3>
                <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', marginTop: 8 }}>
                  {fam.stages.map((st) => (
                    <button key={st.stage_id} className="option" style={{ flexDirection: 'column', textAlign: 'center', filter: st.owned ? 'none' : 'grayscale(.5)', borderColor: st.active ? 'var(--primary)' : 'var(--line)' }}
                      disabled={busy === st.stage_id} onClick={() => equipAvatar(st.stage_id, st.owned, st.required_xp)}>
                      <span style={{ fontSize: 26 }}>{st.owned ? '🦊' : '🔒'}</span>
                      <strong style={{ fontSize: 12 }}>{st.name}</strong>
                      <span className="hint">{st.active ? '✓ Active' : st.owned ? 'Tap to use' : `${st.required_xp ?? 0} XP`}</span>
                    </button>
                  ))}
                </div>
              </Card>
            ))}
          </>
        )}
        {data && tab === 'theme' && (
          <div className="grid">
            {data.themes.map((t) => (
              <Card key={t.id} onClick={() => equipTheme(t.id)} className="">
                <div className="badge-tile">
                  <div style={{ fontSize: 28 }}>{t.owned ? '🎨' : '🔒'}</div>
                  <strong>{t.name}</strong>
                  <span className="hint">{t.active ? '✓ Active' : t.owned ? 'Tap to use' : t.requirement}</span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
