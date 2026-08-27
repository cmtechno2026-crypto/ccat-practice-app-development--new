import React, { useEffect, useState } from 'react';
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
