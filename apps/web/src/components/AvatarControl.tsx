import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@ccat/api-client';
import type { AvatarsResponse, Theme } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { applyPalette, storePalette } from '../lib/theme-apply';

// Emoji per avatar family × stage — mirrors the app mockup's FAM map so the equipped avatar renders
// as a real creature (the gateway stores stage names, not emoji). Falls back to 🦊.
const FAM_EMOJI: Record<string, string[]> = {
  animals: ['🥚', '🐣', '🐥', '🐰', '🦊', '🐺', '🦁'], fox: ['🥚', '🐣', '🐥', '🐰', '🦊', '🐺', '🦁'],
  bird: ['🥚', '🐣', '🐤', '🐦', '🕊️', '🦅', '🦉'],
  aquatic: ['🥚', '🐚', '🐟', '🐠', '🐬', '🦈', '🐋'],
  space: ['🔩', '🤖', '🛰️', '🚀', '🛸', '🌠', '🌌'],
  mythic: ['🥚', '🦎', '🐍', '🐲', '🦄', '🐉', '🔥'],
};
const emojiFor = (key: string, stageNumber: number) => FAM_EMOJI[key?.toLowerCase()]?.[stageNumber - 1] ?? '🦊';

function activeEmoji(a: AvatarsResponse | null): string | null {
  if (!a) return null;
  for (const fam of a.families) for (const st of fam.stages) if (st.active) return emojiFor(fam.key, st.stage_number);
  return null;
}

// Top-right avatar CONTROL: click opens an Avatar + Theme management panel (equip/apply, XP-gated),
// wired to the existing gateway avatars/themes endpoints. Persists + reflects live; Esc / outside-click closes.
export function AvatarControl() {
  const { profile, flash, refreshProfile } = useApp();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'avatar' | 'theme'>('avatar');
  const [avatars, setAvatars] = useState<AvatarsResponse | null>(null);
  const [themes, setThemes] = useState<Theme[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  async function load() {
    setLoading(true);
    try {
      const [a, t] = await Promise.all([client.avatars(), client.themes()]);
      setAvatars(a); setThemes(t);
      // Repaint to the student's active theme (and cache it) so the UI matches server truth on open.
      const active = t.find((x) => x.active);
      if (active) { applyPalette(active.palette); storePalette(active.palette); }
    }
    catch { /* surfaced via empty panel */ } finally { setLoading(false); }
  }
  useEffect(() => { if (open && !avatars) void load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside-click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  async function equipAvatar(stageId: string, requiredXp: number | null) {
    setBusy(stageId);
    try { await client.equipAvatar(stageId); await refreshProfile(); await load(); flash('Avatar equipped!'); }
    catch (e) { flash(e instanceof ApiError && e.code === 'NOT_OWNED' ? `Locked — reach ${requiredXp ?? ''} XP to unlock.` : (e as Error).message); }
    finally { setBusy(null); }
  }
  async function equipTheme(themeId: string, palette?: Record<string, string>) {
    setBusy(themeId);
    // Paint immediately for instant feedback; server confirm + reload follow. Roll back on failure.
    const prev = themes?.find((x) => x.active)?.palette;
    applyPalette(palette); storePalette(palette);
    try { await client.equipTheme(themeId); await refreshProfile(); await load(); flash('Theme applied!'); }
    catch (e) {
      applyPalette(prev); storePalette(prev);
      flash(e instanceof ApiError && e.code === 'NOT_OWNED' ? 'Locked — keep practising to unlock.' : (e as Error).message);
    }
    finally { setBusy(null); }
  }

  const face = profile?.is_preview ? '👀' : (activeEmoji(avatars) ?? '🦊');

  return (
    <div className="avatar-control" ref={wrapRef}>
      <button className="avatar-chip" aria-haspopup="dialog" aria-expanded={open} title="Avatar & theme"
        onClick={() => setOpen((o) => !o)}>{face}</button>
      {open && (
        <div className="avatar-panel" role="dialog" aria-label="Avatar and theme">
          <div className="between" style={{ marginBottom: 10 }}>
            <strong>Customize</strong>
            <button className="btn small ghost" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="row" style={{ marginBottom: 10 }}>
            <button className={`btn small ${tab === 'avatar' ? '' : 'secondary'}`} onClick={() => setTab('avatar')}>🦊 Avatar</button>
            <button className={`btn small ${tab === 'theme' ? '' : 'secondary'}`} onClick={() => setTab('theme')}>🎨 Theme</button>
          </div>
          {loading && <div className="spinner" role="status" aria-label="Loading" />}

          {!loading && tab === 'avatar' && avatars && (
            <>
              <div className="muted" style={{ marginBottom: 8 }}>You have {avatars.xp_total} XP. Unlocked stages equip instantly.</div>
              <div className="avatar-scroll">
                {avatars.families.map((fam) => (
                  <div key={fam.family_id} style={{ marginBottom: 10 }}>
                    <div className="eyebrow" style={{ marginBottom: 6 }}>{fam.name}</div>
                    <div className="avatar-stages">
                      {fam.stages.map((st) => (
                        <button key={st.stage_id} className={`avatar-cell ${st.active ? 'active' : ''} ${st.owned ? '' : 'locked'}`}
                          disabled={busy === st.stage_id || !st.owned} title={st.owned ? st.name : `Locked · ${st.required_xp ?? 0} XP`}
                          onClick={() => equipAvatar(st.stage_id, st.required_xp)}>
                          <span className="face">{st.owned ? emojiFor(fam.key, st.stage_number) : '🔒'}</span>
                          <span className="cap">{st.active ? '✓' : st.owned ? st.name : `${st.required_xp ?? 0}xp`}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {!loading && tab === 'theme' && themes && (
            <div className="theme-grid">
              {themes.map((t) => (
                <button key={t.id} className={`theme-cell ${t.active ? 'active' : ''} ${t.owned ? '' : 'locked'}`}
                  disabled={busy === t.id || !t.owned} title={t.owned ? t.name : t.requirement}
                  onClick={() => equipTheme(t.id, t.palette)}>
                  <span className="swatch" aria-hidden="true"
                    style={{ background: t.palette?.['--primary'] ?? 'var(--primary)' }}>{t.owned ? '' : '🔒'}</span>
                  <strong>{t.name}</strong>
                  <span className="hint">{t.active ? '✓ Active' : t.owned ? 'Apply' : t.requirement}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
