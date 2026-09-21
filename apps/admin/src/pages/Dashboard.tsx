import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorBox } from '../components/ui';

const AVATARS = ['🦊', '🐢', '🦋', '🦖', '🐝', '🦉', '🐬', '🐼', '🦁', '🐧'];
const avatarFor = (id: string) => AVATARS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATARS.length];

function readi(pct: number | null, band: string | null, insufficient: boolean) {
  if (insufficient || pct === null) return { c: 'var(--muted)', label: 'No data', pct: 0 };
  if (band === 'ready' || pct >= 70) return { c: 'var(--green)', label: 'Ready', pct };
  if (band === 'needs_work' || pct < 45) return { c: 'var(--coral)', label: 'Needs work', pct };
  return { c: 'var(--amber)', label: 'Building', pct };
}
function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
const toneColor: Record<string, { bg: string; fg: string }> = {
  green: { bg: 'var(--green-bg)', fg: 'var(--green)' },
  amber: { bg: 'var(--amber-bg)', fg: 'var(--amber)' },
  coral: { bg: 'var(--coral-bg)', fg: 'var(--coral)' },
};

function Delta({ pct, pts }: { pct?: number | null; pts?: number | null }) {
  const v = pct ?? pts;
  if (v === null || v === undefined) return <span className="delta flat">—</span>;
  const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  const sign = v > 0 ? '+' : '';
  return <span className={`delta ${cls}`}>{sign}{v}{pct !== undefined ? '%' : ' pts'}</span>;
}

export function Dashboard() {
  const { me } = useAuth();
  const nav = useNavigate();
  const [window, setWindow] = useState<number>(() => {
    try { return Number(localStorage.getItem('ccat_dash_window')) || 7; } catch { return 7; }
  });
  const [d, setD] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [students, setStudents] = useState<any[] | null>(null);
  const [studentsErr, setStudentsErr] = useState(false);
  const [health, setHealth] = useState<any>(null);
  const isSuper = me?.role === 'super_admin';

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.dashboard(window).then(r => { if (alive) { setD(r); setLoading(false); } }).catch(e => { if (alive) { setError(e); setLoading(false); } });
    return () => { alive = false; };
  }, [window]);
  useEffect(() => {
    api.students({ limit: 5, sort: 'last_active', dir: 'desc' })
      .then(r => setStudents(r.items)).catch(() => setStudentsErr(true));
  }, []);
  // Super-Admin dashboard also carries the inline Service-health panel (mockup).
  useEffect(() => { if (isSuper) api.health().then(setHealth).catch(() => {}); }, [isSuper]);

  const pick = (w: number) => { setWindow(w); try { localStorage.setItem('ccat_dash_window', String(w)); } catch { /* ignore */ } };
  const firstName = (me?.display_name || '').split(' ')[0] || 'there';
  const dotFor = (ev: string) => ev.includes('publish') || ev.includes('created') ? 'var(--green)'
    : ev.includes('revoke') || ev.includes('ban') || ev.includes('deletion') ? 'var(--coral)'
    : ev.includes('suspend') || ev.includes('flag') ? 'var(--amber)' : 'var(--primary)';

  if (error) return (
    <div>
      <div className="greet"><h2>{greeting()}, {firstName}</h2></div>
      <ErrorBox e={error} />
      <button className="btn ghost" onClick={() => setWindow(w => w)}>Retry</button>
    </div>
  );

  const st = d?.platform_state;
  const tone = st ? toneColor[st.tone] ?? toneColor.green : toneColor.green;

  return (
    <div>
      <div className="herohead">
        <div className="greet" style={{ marginBottom: 0 }}>
          <h2>{greeting()}, {firstName}</h2>
          <p className="lead" style={{ marginBottom: 0 }}>{loading ? 'Loading the latest snapshot…' : d?.summary}</p>
        </div>
        <div className="winrow">
          <div className="wintoggle" role="tablist" aria-label="Time range">
            {[7, 30, 90].map(w => <button key={w} className={`winbtn ${window === w ? 'on' : ''}`} onClick={() => pick(w)}>{w} days</button>)}
          </div>
          {st && <span className="statepill" style={{ background: tone.bg, color: tone.fg }} title={st.note}><span className="sdot" />State: {st.label}</span>}
        </div>
      </div>

      {/* hero KPIs (windowed, with deltas) */}
      <div className="kpirow">
        <HeroCard loading={loading} ico="👥" n={d?.hero.active_students.value} delta={<Delta pct={d?.hero.active_students.delta_pct} />} label="Active students" sub={`Students with a session · vs previous ${window}d`} />
        <HeroCard loading={loading} ico="📝" n={d?.hero.sessions_scored.value} delta={<Delta pct={d?.hero.sessions_scored.delta_pct} />} label="Sessions scored" sub={`complete-session · last ${window}d`} />
        <HeroCard loading={loading} ico="🎯" n={d?.hero.avg_readiness.value === null ? '—' : `${d?.hero.avg_readiness.value}%`} delta={<Delta pts={d?.hero.avg_readiness.delta_pts} />} label="Avg readiness" sub="Grades 3–6 · weighted, last 7 days" />
        <HeroCard loading={loading} ico="✅" n={d?.hero.session_success.value_pct === null ? '—' : `${d?.hero.session_success.value_pct}%`} delta={<span className="delta flat">{d ? `${d.hero.session_success.dead_letter} not scored` : ''}</span>} label="Session success" sub={`complete-session · last ${window}d`} />
      </div>

      {/* BLUEPRINT-ADD: secondary operational metrics (New/Suspended/In-progress/Incidents) — not in the
          mockup's KPI row; kept as an additive strip using the same KPI card design so it stays consistent. */}
      <div className="kpirow">
        <MiniCard loading={loading} ico="🆕" bg="var(--tint)" n={d?.students.new_in_window} label="New students" sub={`last ${window}d`} />
        <MiniCard loading={loading} ico="⏸️" bg="var(--amber-bg)" n={d?.students.suspended} label="Suspended" sub="active suspensions" />
        <MiniCard loading={loading} ico="▶️" bg="var(--tint)" n={d?.sessions.in_progress} label="Sessions in progress" sub="live now" />
        <MiniCard loading={loading} ico={d?.open_incidents ? '🚨' : '✅'} bg={d?.open_incidents ? 'var(--coral-bg)' : 'var(--green-bg)'} n={d?.open_incidents} label="Open incidents" sub="unresolved" />
      </div>

      <div className="dashcols">
        {/* LEFT column: students preview, then (super only) Super-Admin controls */}
        <div className="dashcol">
          <div className="panel">
            <div className="panelhead"><h3>Students</h3><Link to="/students">View all →</Link></div>
            <p className="muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 6 }}>Most recently active · click a name for the full record</p>
            {studentsErr ? <div className="empty">Couldn't load students.</div>
              : students === null ? <div className="empty">Loading…</div>
              : students.length === 0 ? <div className="empty">No students yet — they appear here after registering in the app.</div>
              : students.map((r: any) => {
                const rd = readi(r.readiness_pct, r.readiness_band, r.readiness_insufficient);
                return (
                  <div className="minirow" key={r.id}>
                    <span className="stud" style={{ gap: 10 }}><span className="av">{avatarFor(r.id)}</span></span>
                    <div className="grow">
                      <span className="stud"><span className="nm" onClick={() => nav(`/students/${r.id}`)}>{r.username}</span></span>
                      <div className="un" style={{ fontSize: 12, color: 'var(--muted)' }}>Grade {r.grade_number}</div>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: 120 }}>
                      <span className="tabnum" style={{ color: rd.c, fontWeight: 800, fontSize: 13 }}>{rd.label}</span>
                      <div className="rbar" style={{ marginLeft: 'auto' }}><i style={{ width: `${Math.max(4, rd.pct)}%`, background: rd.c }} /></div>
                    </div>
                    <button className="btn ghost sm" style={{ marginLeft: 10 }} onClick={() => nav(`/students/${r.id}`)}>Devices</button>
                  </div>
                );
              })}
          </div>
          {isSuper && <DiscountControl />}
          {isSuper && <SuperControls d={d} />}
        </div>

        {/* RIGHT column: (super only) Service health, then recent activity */}
        <div className="dashcol">
          {isSuper && <ServiceHealth health={health} />}
          <div className="panel">
            <div className="panelhead"><h3>Recent activity</h3><Link to="/audit">Open audit log →</Link></div>
            {loading ? <div className="empty">Loading…</div>
              : !d?.recent_activity?.length ? <div className="empty">No recent admin activity.</div>
              : d.recent_activity.slice(0, 8).map((a: any, i: number) => (
                <div className="actitem" key={i}>
                  <span className="adot" style={{ background: dotFor(a.event_type) }} />
                  <div>
                    <div className="atext">{a.event_type.replace(/\./g, ' ').replace(/_/g, ' ')}{a.reason ? ` — ${a.reason}` : ''}</div>
                    <div className="ameta">{new Date(a.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {a.actor || 'system'}{a.request_id ? ` · req_${String(a.request_id).slice(0, 8)}` : ''}</div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Super-Admin controls panel (mockup): quick entry points that are NOT on the rail.
function SuperControls({ d }: { d: any }) {
  const nav = useNavigate();
  const rows = [
    { to: '/gamification/economy', ico: '⚙️', title: 'Coins, XP & readiness bands', sub: 'Reward economy config + integrity' },
    { to: '/config/flags', ico: '🚩', title: 'Feature flags & app_config', sub: 'Versioned runtime configuration' },
    { to: '/admins', ico: '➕', title: 'Create a new admin', sub: 'Issue an ID and temporary password' },
  ];
  return (
    <div className="panel">
      <div className="panelhead"><h3>Super-Admin controls</h3></div>
      {rows.map(r => (
        <button key={r.to} className="ctrlrow" onClick={() => nav(r.to)}>
          <span className="ctrlico">{r.ico}</span>
          <span className="grow" style={{ textAlign: 'left' }}>
            <span className="ctrltitle">{r.title}</span>
            <span className="ctrlsub">{r.sub}</span>
          </span>
          <span className="ctrlchev">›</span>
        </button>
      ))}
    </div>
  );
}

// Inline Service-health panel for the Super-Admin dashboard (real /v1/admin/health data).
function ServiceHealth({ health }: { health: any }) {
  const stateColor = (s: string) => s === 'Healthy' ? 'var(--green)' : s === 'Degraded' ? 'var(--amber)' : s === 'Unknown' ? 'var(--muted)' : 'var(--coral)';
  // SLO bars are true 0–100 success-rate indicators only. Everything else (drift counts,
  // latency ms, up/down) is a value row — a 0-mismatch count must not render as an empty bar.
  const SLO_KEYS = ['session_submit', 'content_delivery', 'login_success', 'provider_health', 'availability', 'crash_free_sessions'];
  const isPct = (i: any) => SLO_KEYS.includes(i.indicator) && typeof i.value === 'number';
  const bars = (health?.indicators || []).filter(isPct);
  const rows = (health?.indicators || []).filter((i: any) => !isPct(i) && (i.detail || typeof i.value === 'number'));
  const allGreen = health && (health.overall === 'Healthy');
  return (
    <div className="panel healthpanel">
      <div className="panelhead">
        <h3>Service health</h3>
        <Link to="/health">→</Link>
      </div>
      {!health ? <div className="empty" style={{ color: 'inherit' }}>Loading…</div> : (
        <>
          <div className={`slochip ${allGreen ? 'ok' : 'warn'}`}>{allGreen ? 'ALL SLOs GREEN' : 'NEEDS ATTENTION'}</div>
          {bars.slice(0, 5).map((i: any, k: number) => (
            <div className="slorow" key={k}>
              <span className="slolabel">{i.indicator.replace(/_/g, ' ')}</span>
              <div className="slobar"><i style={{ width: `${Math.min(100, Math.max(3, i.value))}%`, background: stateColor(i.state) }} /></div>
              <span className="sloval tabnum">{i.value}%</span>
            </div>
          ))}
          <div className="slometa">
            {rows.slice(0, 4).map((i: any, k: number) => (
              <div className="slometarow" key={k}><span className="sdot2" style={{ background: stateColor(i.state) }} />{i.indicator.replace(/_/g, ' ')}<span className="grow" /><span className="tabnum">{i.detail || i.value}</span></div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Vertical KPI card matching the mockup: uppercase label, big number + inline delta, subtitle,
// icon tile top-right.
function HeroCard({ loading, ico, n, delta, label, sub }: { loading: boolean; ico: string; n: any; delta: React.ReactNode; label: string; sub?: string }) {
  return (
    <div className="kpi hero">
      <div className="ico">{ico}</div>
      <div className="klabel">{label}</div>
      {loading ? <div className="skeleton" style={{ height: 30, width: 84, marginTop: 8 }} /> : <div className="n big tabnum">{typeof n === 'number' ? n.toLocaleString() : n}{delta}</div>}
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
function MiniCard({ loading, ico, bg, n, label, sub }: { loading: boolean; ico: string; bg: string; n: any; label: string; sub?: string }) {
  return (
    <div className="kpi hero">
      <div className="ico" style={{ background: bg }}>{ico}</div>
      <div className="klabel">{label}</div>
      {loading ? <div className="skeleton" style={{ height: 28, width: 48, marginTop: 8 }} /> : <div className="n tabnum">{typeof n === 'number' ? n.toLocaleString() : (n ?? 0)}</div>}
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

// ---- Discount control (Super-Admin) — schedules the site-wide half-price promo -------------------------
// Times are entered in IST and stored as UTC. Display-only: this drives the landing banner/countdown and
// the halved prices on landing pricing + My Plan; it does NOT change the PayPal charge amount.
const pad2 = (n: number) => String(n).padStart(2, '0');
function to24(h12: number, pm: boolean): number { const h = h12 % 12; return pm ? h + 12 : h; }
function istToUtcIso(dateStr: string, h12: number, m: number, pm: boolean): string {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const utc = Date.UTC(Y!, (M! - 1), D!, to24(h12, pm), m) - 330 * 60000; // IST = UTC+5:30
  return new Date(utc).toISOString();
}
function utcIsoToIst(iso: string): { date: string; h12: number; m: number; pm: boolean } {
  const d = new Date(new Date(iso).getTime() + 330 * 60000);
  const h24 = d.getUTCHours(); const pm = h24 >= 12; let h12 = h24 % 12; if (h12 === 0) h12 = 12;
  return { date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`, h12, m: d.getUTCMinutes(), pm };
}
function addDaysStr(dateStr: string, days: number): string {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(Y!, (M! - 1), D!)); d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
// Time box: type the hour/minute freely (backspace to empty; an empty field defaults to 12:00 on blur) or
// adjust with the mouse wheel; ONE AM/PM button toggles between AM and PM on each click. No icons/arrows.
function TimeField({ h12, m, pm, onChange }: { h12: number; m: number; pm: boolean; onChange: (h: number, m: number, pm: boolean) => void }) {
  const hRef = useRef<HTMLInputElement>(null);
  const mRef = useRef<HTMLInputElement>(null);
  // Local strings so backspacing to empty works while typing (the parent only ever holds a valid number).
  const [hStr, setHStr] = useState(pad2(h12));
  const [mStr, setMStr] = useState(pad2(m));
  useEffect(() => { setHStr(pad2(h12)); }, [h12]);
  useEffect(() => { setMStr(pad2(m)); }, [m]);
  useEffect(() => {
    const hEl = hRef.current, mEl = mRef.current; if (!hEl || !mEl) return;
    const wh = (e: WheelEvent) => { e.preventDefault(); let n = h12 + (e.deltaY < 0 ? 1 : -1); if (n > 12) n = 1; if (n < 1) n = 12; onChange(n, m, pm); };
    const wm = (e: WheelEvent) => { e.preventDefault(); let n = m + (e.deltaY < 0 ? 1 : -1); if (n > 59) n = 0; if (n < 0) n = 59; onChange(h12, n, pm); };
    hEl.addEventListener('wheel', wh, { passive: false }); mEl.addEventListener('wheel', wm, { passive: false });
    return () => { hEl.removeEventListener('wheel', wh); mEl.removeEventListener('wheel', wm); };
  }, [h12, m, pm, onChange]);

  const onHChange = (v: string) => { const digits = v.replace(/\D/g, '').slice(0, 2); setHStr(digits); if (digits !== '') { let n = parseInt(digits, 10); if (n > 12) n = 12; if (n < 1) n = 1; onChange(n, m, pm); } };
  const onMChange = (v: string) => { const digits = v.replace(/\D/g, '').slice(0, 2); setMStr(digits); if (digits !== '') { let n = parseInt(digits, 10); if (n > 59) n = 59; if (n < 0) n = 0; onChange(h12, n, pm); } };
  // On blur an empty field falls back to a clean default (12 for the hour, 00 for minutes).
  const onHBlur = () => { if (hStr === '') { setHStr('12'); onChange(12, m, pm); } else setHStr(pad2(h12)); };
  const onMBlur = () => { if (mStr === '') { setMStr('00'); onChange(h12, 0, pm); } else setMStr(pad2(m)); };

  const box: React.CSSProperties = { width: 36, minWidth: 36, boxSizing: 'border-box', textAlign: 'center', fontWeight: 800, fontSize: 18, border: 0, background: 'transparent', outline: 'none', padding: 0 };
  const toggle: React.CSSProperties = { border: '1px solid var(--primary,#1A5EAB)', background: 'var(--primary,#1A5EAB)', color: '#fff', fontWeight: 800, fontSize: 12, borderRadius: 8, padding: '7px 14px', cursor: 'pointer', minWidth: 48 };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line,#e3e7f0)', borderRadius: 10, background: '#fff', padding: '6px 12px' }}>
      <input ref={hRef} inputMode="numeric" value={hStr} style={box} onChange={(e) => onHChange(e.target.value)} onBlur={onHBlur} aria-label="Hour" />
      <span style={{ fontWeight: 800, fontSize: 18, color: '#6b7180' }}>:</span>
      <input ref={mRef} inputMode="numeric" value={mStr} style={box} onChange={(e) => onMChange(e.target.value)} onBlur={onMBlur} aria-label="Minute" />
      <button type="button" onClick={() => onChange(h12, m, !pm)} title="Click to switch AM / PM" style={toggle}>{pm ? 'PM' : 'AM'}</button>
    </div>
  );
}

function DiscountControl() {
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState(false);
  const [liveNow, setLiveNow] = useState(false);
  const [percent, setPercent] = useState(50);
  const [headline, setHeadline] = useState('50% Off All Plans — Limited Time!');
  const [sDate, setSDate] = useState(''); const [sH, setSH] = useState(9); const [sM, setSM] = useState(0); const [sPM, setSPM] = useState(false);
  const [eDate, setEDate] = useState(''); const [eH, setEH] = useState(9); const [eM, setEM] = useState(0); const [ePM, setEPM] = useState(false);
  const [saving, setSaving] = useState(false); const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const today = utcIsoToIst(new Date().toISOString()).date;
    api.getPromo().then((p) => {
      setActive(p.active); setLiveNow(p.live_now); setPercent(p.percent || 50);
      setHeadline(p.headline || '50% Off All Plans — Limited Time!');
      if (p.starts_at) { const s = utcIsoToIst(p.starts_at); setSDate(s.date); setSH(s.h12); setSM(s.m); setSPM(s.pm); } else setSDate(today);
      if (p.ends_at) { const e = utcIsoToIst(p.ends_at); setEDate(e.date); setEH(e.h12); setEM(e.m); setEPM(e.pm); } else setEDate(addDaysStr(today, 3));
    }).catch(() => { setSDate(today); setEDate(addDaysStr(today, 3)); }).finally(() => setLoaded(true));
  }, []);

  async function save(nextActive: boolean) {
    setSaving(true); setMsg(null);
    try {
      const starts_at = sDate ? istToUtcIso(sDate, sH, sM, sPM) : null;
      const ends_at = eDate ? istToUtcIso(eDate, eH, eM, ePM) : null;
      const r = await api.setPromo({ active: nextActive, percent, starts_at, ends_at, headline: headline.trim() || '50% Off All Plans — Limited Time!' });
      setActive(nextActive); setLiveNow(r.live_now);
      setMsg(nextActive ? (r.live_now ? 'Saved — discount is LIVE.' : 'Saved — scheduled.') : 'Discount ended.');
    } catch (e: any) { setMsg(e?.message || 'Could not save.'); }
    finally { setSaving(false); }
  }

  if (!loaded) return <div className="panel"><div className="panelhead"><h3>Discount</h3></div><div className="empty">Loading…</div></div>;

  const tag = liveNow ? { t: '● Live now', bg: 'var(--green-bg)', c: 'var(--green)' } : active ? { t: 'Scheduled', bg: 'var(--amber-bg)', c: 'var(--amber)' } : { t: 'Off', bg: 'var(--tint,#eef1f7)', c: 'var(--muted)' };
  const lab: React.CSSProperties = { fontWeight: 700, fontSize: 12.5, color: '#33405c', margin: '0 0 6px', display: 'block' };
  const dinput: React.CSSProperties = { border: '1px solid var(--line,#e3e7f0)', borderRadius: 10, padding: '10px 12px', fontWeight: 700, fontSize: 14, background: '#fff' };

  return (
    <div className="panel">
      <div className="panelhead" style={{ alignItems: 'center' }}>
        <h3>🏷️ Discount</h3>
        <span style={{ marginLeft: 'auto', fontWeight: 800, fontSize: 11, borderRadius: 999, padding: '3px 11px', background: tag.bg, color: tag.c }}>{tag.t}</span>
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>Half-price banner + prices on the landing page, pricing &amp; Plan page. Times are IST; ends automatically.</p>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
        <div><label style={lab}>Discount %</label>
          <input value={percent} inputMode="numeric" style={{ ...dinput, width: 80 }}
            onChange={(e) => { let n = parseInt(e.target.value.replace(/\D/g, ''), 10); if (isNaN(n)) n = 0; setPercent(Math.max(1, Math.min(90, n))); }} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}><label style={lab}>Banner headline</label>
          <input value={headline} maxLength={120} style={{ ...dinput, width: '100%' }} onChange={(e) => setHeadline(e.target.value)} />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <label style={lab}>▶ Start (IST)</label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input type="date" value={sDate} onChange={(e) => setSDate(e.target.value)} style={dinput} />
          <TimeField h12={sH} m={sM} pm={sPM} onChange={(h, m, pm) => { setSH(h); setSM(m); setSPM(pm); }} />
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <label style={lab}>■ End (IST)</label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input type="date" value={eDate} onChange={(e) => setEDate(e.target.value)} style={dinput} />
          <TimeField h12={eH} m={eM} pm={ePM} onChange={(h, m, pm) => { setEH(h); setEM(m); setEPM(pm); }} />
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Tip: type the time, or hover the hour/minute and scroll the mouse wheel.</div>

      {msg && <div className="muted" style={{ fontSize: 12.5, marginTop: 10, fontWeight: 700 }}>{msg}</div>}

      <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
        {active && <button className="btn ghost" disabled={saving} onClick={() => save(false)}>End now</button>}
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={saving} onClick={() => save(true)}>{saving ? 'Saving…' : active ? 'Update discount' : 'Start discount'}</button>
      </div>
    </div>
  );
}
