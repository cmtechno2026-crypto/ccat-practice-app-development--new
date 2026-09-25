import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { PAYMENTS_ENABLED } from '../lib/payments';
import { api } from '../lib/api';

// Request kinds surfaced in the bell + Students highlighting, each with its own colour so the two
// surfaces read consistently (grade-change = blue, deletion = coral, break-glass = amber).
export const NOTIF_META: Record<string, { label: string; color: string; icon: string }> = {
  grade_change: { label: 'Grade change', color: '#2f6fd0', icon: '🎓' },
  deletion: { label: 'Deletion', color: 'var(--coral, #e0533d)', icon: '🗑️' },
  break_glass: { label: 'Break-glass', color: 'var(--amber, #e0a030)', icon: '🔑' },
};

// Notification bell — aggregated pending requests the admin can act on. Polls every 60s and refreshes
// on open. Each row is colour-coded by kind and deep-links to the student. Empty for admins with none
// of the relevant permissions (the endpoint self-filters), so the badge simply never appears for them.
function NotificationBell() {
  const nav = useNavigate();
  const { activeSite } = useAuth();
  const teacherMode = activeSite === 'teacher';
  const [items, setItems] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const load = () => {
    if (teacherMode) {
      // Teacher Hub scope: pending parent booking requests (via booking links) + pending teacher leave.
      Promise.all([
        api.teacherBookingRequests({ status: 'pending' }).then(r => r.requests || []).catch(() => []),
        api.teacherLeaveRequests('pending').then(r => (r.requests as any[]) || []).catch(() => []),
      ]).then(([reqs, leaves]) => {
        const bi = (reqs as any[]).map(r => ({ scope: 'teacher', kind: 'booking', id: r.id, title: r.parent_name, sub: `${(r.slots || []).length} slot(s) requested`, created_at: r.created_at }));
        const li = (leaves as any[]).map(l => ({ scope: 'teacher', kind: 'leave', id: l.id, title: l.teacher_name, sub: `Leave ${l.start_date}${l.end_date && l.end_date !== l.start_date ? ' – ' + l.end_date : ''}`, created_at: l.created_at }));
        setItems([...bi, ...li].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
      });
    } else {
      api.notifications().then(r => setItems((r.items || []).map((n: any) => ({ scope: 'ccat', ...n })))).catch(() => { /* ignore */ });
    }
  };
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [teacherMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = items.length;
  const TMETA: Record<string, { label: string; color: string; icon: string }> = { booking: { label: 'Booking request', color: 'var(--brand,#2f6fd0)', icon: '📥' }, leave: { label: 'Leave request', color: '#7c3aed', icon: '🌴' } };
  return (
    <div style={{ position: 'relative' }}>
      <button className="iconbtn" onClick={() => { const willOpen = !open; setOpen(willOpen); if (willOpen) load(); }} title={teacherMode ? 'Teacher Hub notifications' : 'Requests'} aria-label={`Notifications${count ? ` (${count})` : ''}`} style={{ position: 'relative' }}>
        🔔
        {count > 0 && <span style={{ position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 9, background: 'var(--coral, #e0533d)', color: '#fff', fontSize: 10, lineHeight: '16px', textAlign: 'center', fontWeight: 700, boxSizing: 'border-box' }}>{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <>
          <button onClick={() => setOpen(false)} aria-label="Close notifications" style={{ position: 'fixed', inset: 0, background: 'transparent', border: 0, zIndex: 40, cursor: 'default' }} />
          <div role="menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 340, maxHeight: 440, overflowY: 'auto', background: 'var(--card, #fff)', color: 'var(--ink, #1a1a2e)', border: '1px solid var(--line, #e6e6ef)', borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,.18)', zIndex: 41 }}>
            <div style={{ padding: '12px 14px', fontWeight: 700, borderBottom: '1px solid var(--line, #e6e6ef)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{teacherMode ? 'Teacher Hub' : 'Requests'}</span><span className="muted" style={{ fontWeight: 600 }}>{count}</span>
            </div>
            {count === 0
              ? <div className="muted" style={{ padding: '18px 14px' }}>Nothing pending.</div>
              : items.map((n) => {
                if (n.scope === 'teacher') {
                  const m = TMETA[n.kind] || { label: n.kind, color: 'var(--amber,#e0a030)', icon: '•' };
                  return (
                    <button key={`${n.kind}:${n.id}`} role="menuitem" onClick={() => { setOpen(false); nav('/teacherhub/requests'); }}
                      style={{ display: 'flex', gap: 10, width: '100%', textAlign: 'left', padding: '10px 14px', background: 'transparent', border: 0, borderLeft: `4px solid ${m.color}`, borderBottom: '1px solid var(--line, #eee)', cursor: 'pointer' }}>
                      <span aria-hidden style={{ fontSize: 16 }}>{m.icon}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>{n.title}</span>
                        <span style={{ display: 'block', fontSize: 12, color: m.color, fontWeight: 600 }}>{m.label}</span>
                        <span className="muted" style={{ display: 'block', fontSize: 12 }}>{n.sub}</span>
                        <span className="muted" style={{ display: 'block', fontSize: 11 }}>{new Date(n.created_at).toLocaleString()}</span>
                      </span>
                    </button>
                  );
                }
                const m = NOTIF_META[n.kind] || { label: n.kind, color: 'var(--amber, #e0a030)', icon: '•' };
                return (
                  <button key={`${n.kind}:${n.id}`} role="menuitem" onClick={() => { setOpen(false); nav(`/students/${n.student_id}`); }}
                    style={{ display: 'flex', gap: 10, width: '100%', textAlign: 'left', padding: '10px 14px', background: 'transparent', border: 0, borderLeft: `4px solid ${m.color}`, borderBottom: '1px solid var(--line, #eee)', cursor: 'pointer' }}>
                    <span aria-hidden style={{ fontSize: 16 }}>{m.icon}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 700, fontSize: 13 }}>{n.student_name}</span>
                      <span style={{ display: 'block', fontSize: 12, color: m.color, fontWeight: 600 }}>{m.label}</span>
                      <span className="muted" style={{ display: 'block', fontSize: 12 }}>{n.summary}</span>
                      <span className="muted" style={{ display: 'block', fontSize: 11 }}>{new Date(n.created_at).toLocaleString()}</span>
                    </span>
                  </button>
                );
              })}
          </div>
        </>
      )}
    </div>
  );
}

interface Tab { to: string; label: string; perm?: string; }
interface RailItem { to: string; label: string; ic: string; perm?: string; match: string; tabs?: Tab[]; badge?: number; }

// Rail matches the CCAT Admin Web mockup EXACTLY: 7 items, identical for both roles (Admin and
// Super-Admin see the same rail; pages enforce RBAC server-side). Service Health, Coins & XP,
// Feature flags, and Create-admin are NOT rail items — they are reached from the Super-Admin
// dashboard controls panel and from in-page tabs. Icons use the mockup's emoji glyphs.
const BASE_RAIL: RailItem[] = [
  { to: '/', label: 'Dashboard', ic: '📊', match: '/' },
  // Content's Practice-sets/Exam-papers toggle is rendered in-page as pills (mockup), not as a top strip.
  { to: '/content', label: 'Content', ic: '📚', match: '/content' },
  { to: '/students', label: 'Students', ic: '🧒', match: '/students' },
  // Gamification's Achievements/Avatars/Themes toggle is rendered in-page as pills (mockup).
  { to: '/gamification/achievements', label: 'Gamification', ic: '🏆', match: '/gamification' },
  { to: '/teachers', label: 'Teachers', ic: '👩‍🏫', match: '/teachers', perm: 'teacher.students.manage' },
  { to: '/announcements', label: 'Announcements', ic: '📣', match: '/announcements' },
  { to: '/audit', label: 'Audit log', ic: '🧾', match: '/audit' },
];

// Payments Phase 2 — the Membership grant is a Super-Admin control shown ONLY when the flag is on.
// When off, RAIL === BASE_RAIL, so the rail is identical to today.
const RAIL: RailItem[] = PAYMENTS_ENABLED
  ? [...BASE_RAIL, { to: '/config/membership', label: 'Membership', ic: '💳', match: '/config/membership', perm: 'config.global' }]
  : BASE_RAIL;

// Teacher Hub rail (multi-site admin). Shown when the active site is 'teacher'. Items gate on
// teacher.* permissions; super_admin sees all.
const TEACHER_RAIL: RailItem[] = [
  { to: '/teacherhub', label: 'Dashboard', ic: '📊', match: '/teacherhub', perm: 'teacher.directory' },
  { to: '/teacherhub/teachers', label: 'Teachers', ic: '👩\u200d🏫', match: '/teacherhub/teachers', perm: 'teacher.directory' },
  { to: '/teacherhub/booking-links', label: 'Link Generator', ic: '🔗', match: '/teacherhub/booking-links', perm: 'teacher.directory' },
  { to: '/teacherhub/requests', label: 'Requests', ic: '📥', match: '/teacherhub/requests', perm: 'teacher.directory' },
  { to: '/audit', label: 'Audit log', ic: '🧾', match: '/audit' },
];
const SITE_NAMES: Record<string, string> = { ccat: 'CCAT Practice', teacher: 'Teacher Hub' };
function railForSite(site: string): RailItem[] { return site === 'teacher' ? TEACHER_RAIL : RAIL; }

// Teacher accounts see ONLY the student directory — every other admin feature is locked away (both the
// rail here and the routes in App.tsx). Their student reads are scoped to assigned students server-side.
const TEACHER_ONLY_RAIL: RailItem[] = [
  { to: '/students', label: 'Students', ic: '🧒', match: '/students' },
  { to: '/teacher-practice', label: 'Practice', ic: '📚', match: '/teacher-practice' },
  { to: '/teacher-exam', label: 'Exam', ic: '📝', match: '/teacher-exam' },
];

function sectionFor(path: string, rail: RailItem[]): RailItem | undefined {
  // longest match wins so '/' doesn't swallow everything
  return [...rail].filter(r => (r.match === '/' ? path === '/' : path.startsWith(r.match)))
    .sort((a, b) => b.match.length - a.match.length)[0];
}

export function Layout() {
  const { me, logout, can, sites, activeSite, switchSite } = useAuth();
  const loc = useLocation();
  const [siteMenu, setSiteMenu] = useState(false);
  const RAIL_ACTIVE = me?.is_teacher ? TEACHER_ONLY_RAIL : railForSite(activeSite);
  // Keep the active site in sync with the URL so a hard refresh / deep-link to a /teacher/* page shows
  // the Teacher Hub chrome (rail, header, switcher) instead of falling back to CCAT. URL is the source
  // of truth for which workspace is shown; teacher-role accounts keep their own dedicated rail.
  useEffect(() => {
    if (me?.is_teacher) return;
    const onTeacherHub = loc.pathname === '/teacherhub' || loc.pathname.startsWith('/teacherhub/'); // not /teacher-practice|/teacher-exam (CCAT)
    if (onTeacherHub && sites.includes('teacher') && activeSite !== 'teacher') switchSite('teacher');
  }, [loc.pathname, sites, activeSite, me, switchSite]);
  // Home path for the active site: the brand logo and the back-link go here, so from Teacher Hub they
  // land on the Teacher dashboard, not the CCAT one.
  const homePath = me?.is_teacher ? '/students' : (activeSite === 'teacher' ? '/teacherhub' : '/');
  const nav = useNavigate();
  // Sign out AND reset the URL to the default route, so the stale protected page can't be replayed on the
  // next sign-in (the router unmounts once logged out; without this the address bar keeps the old path).
  const signOut = () => { logout(); nav('/', { replace: true }); }; // logout unmounts the router; '/' is fine
  // Mobile hamburger drawer (desktop uses the CSS hover-expand rail; this only matters below 860px).
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [loc.pathname]); // route change closes the drawer
  // Live pending-booking-requests count for the Teacher Hub rail badge. Polls every 60s while the
  // Teacher Hub site is active and the admin can view it; failures are swallowed (a badge is cosmetic).
  const [pendingReq, setPendingReq] = useState(0);
  useEffect(() => {
    if (me?.is_teacher || activeSite !== 'teacher' || !can('teacher.directory')) { setPendingReq(0); return; }
    let alive = true;
    const load = () => { api.teacherBookingRequestsPending().then(r => { if (alive) setPendingReq(r.pending || 0); }).catch(() => {}); };
    load(); const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [activeSite, me?.is_teacher, loc.pathname]);
  const [theme, setTheme] = useState<string>(document.documentElement.getAttribute('data-theme') || 'light');
  const toggleTheme = () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next); setTheme(next);
    try { localStorage.setItem('ccat_admin_theme', next); } catch (e) { /* ignore */ }
  };

  const visible = RAIL_ACTIVE.filter(r => !r.perm || can(r.perm));
  const section = sectionFor(loc.pathname, RAIL_ACTIVE);
  // Off-rail Super-Admin pages reached from the dashboard controls panel (mockup): show a
  // "← Dashboard" affordance + a proper title instead of falling back to the brand name.
  const OFF_RAIL: { match: string; label: string }[] = [
    { match: '/health', label: 'Service health' },
    { match: '/admins', label: 'Admin accounts' },
    { match: '/config', label: 'Configuration' },
  ];
  const offRail = section ? undefined : OFF_RAIL.find(o => loc.pathname.startsWith(o.match));
  const title = loc.pathname.startsWith('/students/') ? 'Student detail' : (section?.label || offRail?.label || SITE_NAMES[activeSite] || 'Admin');
  const initials = (me?.display_name || 'CM').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
  const tabs = section?.tabs?.filter(t => !t.perm || can(t.perm)) || [];

  return (
    <div className="shell">
      <nav className={`rail ${drawer ? 'open' : ''}`} aria-label="Primary">
        <button className="railclose" onClick={() => setDrawer(false)} aria-label="Close menu">✕</button>
        <Link to={homePath} className="brandhdr" aria-label="Dashboard">
          <span className="logo"><span className="cm">CM</span></span>
          <span className="bt"><b>{activeSite === 'teacher' ? 'Teacher Hub' : 'CCAT Admin'}</b><span>v8.0 · ca-central-1</span></span>
        </Link>
        {visible.map(r => (
          <NavLink
            key={r.to}
            to={r.to}
            className={() => `railitem ${section?.match === r.match ? 'active' : ''}`}
            aria-label={r.label}
          >
            <span className="ricon" aria-hidden>{r.ic}</span>
            <span className="rlabel">{r.label}</span>
            {r.to === '/teacherhub/requests' && pendingReq > 0 && (
              <span aria-label={`${pendingReq} pending`} style={{ marginLeft: 'auto', minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, background: 'var(--coral,#e0533d)', color: '#fff', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{pendingReq > 99 ? '99+' : pendingReq}</span>
            )}
          </NavLink>
        ))}
        <span className="spacer" />
        <div className="railfoot">
          <div className="me" title={me?.display_name}>{initials}</div>
          <div className="who2">
            <div className="n">{me?.display_name}</div>
            <div className="r">{me?.role === 'super_admin' ? 'Super-Admin' : 'Admin'}</div>
          </div>
        </div>
      </nav>

      {/* Dim scrim behind the mobile drawer; tapping it closes the drawer (CSS hides it on desktop). */}
      {drawer && <button className="scrim" aria-label="Close menu" onClick={() => setDrawer(false)} />}

      <div className="content">
        <div className="topbar">
          <span style={{ display: 'flex', alignItems: 'center' }}>
            <button className="iconbtn hamburger" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer}>☰</button>
            {offRail && <Link to={homePath} className="backlink">← Dashboard</Link>}
            <span className="title">{title}</span>
          </span>
          <div className="who">
            {sites.length > 1 && (
              <div role="tablist" aria-label="Workspace" style={{ display: 'inline-flex', background: 'var(--card2,#eef2f7)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 9, padding: 3, gap: 3, marginRight: 4 }}>
                {sites.map(sid => {
                  const on = sid === activeSite;
                  return (
                    <button key={sid} role="tab" aria-selected={on}
                      onClick={() => { if (sid !== activeSite) { switchSite(sid); nav(sid === 'teacher' ? '/teacherhub' : '/', { replace: true }); } }}
                      style={{ border: 0, background: on ? 'var(--card,#fff)' : 'transparent', color: on ? (sid === 'teacher' ? 'var(--teal,#0f766e)' : 'var(--brand,#2f6fd0)') : 'var(--muted,#647089)', fontWeight: 800, fontSize: 12.5, padding: '6px 12px', borderRadius: 7, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, boxShadow: on ? '0 1px 3px rgba(0,0,0,.10)' : 'none' }}>
                      {on && <span style={{ width: 7, height: 7, borderRadius: '50%', background: sid === 'teacher' ? 'var(--teal,#0f766e)' : 'var(--amber,#e0a030)' }} />}
                      {SITE_NAMES[sid] || sid}
                    </button>
                  );
                })}
              </div>
            )}
            <NotificationBell />
            <button className="iconbtn" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">◐</button>
            <button className="btn ghost sm" onClick={signOut}>Sign out</button>
          </div>
        </div>
        {tabs.length > 1 && (
          <div className="sectiontabs" role="tablist">
            {tabs.map(t => (
              <NavLink key={t.to} to={t.to} className={({ isActive }) => `sectiontab ${isActive ? 'active' : ''}`}>
                {t.label}
              </NavLink>
            ))}
          </div>
        )}
        <div className="page"><Outlet /></div>
      </div>
    </div>
  );
}
