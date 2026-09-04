import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { PAYMENTS_ENABLED } from '../lib/payments';

interface Tab { to: string; label: string; perm?: string; }
interface RailItem { to: string; label: string; ic: string; perm?: string; match: string; tabs?: Tab[]; }

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
  { to: '/books', label: 'Book Store', ic: '📖', match: '/books' },
  { to: '/announcements', label: 'Announcements', ic: '📣', match: '/announcements' },
  { to: '/audit', label: 'Audit log', ic: '🧾', match: '/audit' },
];

// Payments Phase 2 — the Membership grant is a Super-Admin control shown ONLY when the flag is on.
// When off, RAIL === BASE_RAIL, so the rail is identical to today.
const RAIL: RailItem[] = PAYMENTS_ENABLED
  ? [...BASE_RAIL, { to: '/config/membership', label: 'Membership', ic: '💳', match: '/config/membership', perm: 'config.global' }]
  : BASE_RAIL;

function sectionFor(path: string): RailItem | undefined {
  // longest match wins so '/' doesn't swallow everything
  return [...RAIL].filter(r => (r.match === '/' ? path === '/' : path.startsWith(r.match)))
    .sort((a, b) => b.match.length - a.match.length)[0];
}

export function Layout() {
  const { me, logout, can } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  // Sign out AND reset the URL to the default route, so the stale protected page can't be replayed on the
  // next sign-in (the router unmounts once logged out; without this the address bar keeps the old path).
  const signOut = () => { logout(); nav('/', { replace: true }); };
  // Mobile hamburger drawer (desktop uses the CSS hover-expand rail; this only matters below 860px).
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [loc.pathname]); // route change closes the drawer
  const [theme, setTheme] = useState<string>(document.documentElement.getAttribute('data-theme') || 'light');
  const toggleTheme = () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next); setTheme(next);
    try { localStorage.setItem('ccat_admin_theme', next); } catch (e) { /* ignore */ }
  };

  const visible = RAIL.filter(r => !r.perm || can(r.perm));
  const section = sectionFor(loc.pathname);
  // Off-rail Super-Admin pages reached from the dashboard controls panel (mockup): show a
  // "← Dashboard" affordance + a proper title instead of falling back to the brand name.
  const OFF_RAIL: { match: string; label: string }[] = [
    { match: '/health', label: 'Service health' },
    { match: '/admins', label: 'Admin accounts' },
    { match: '/config', label: 'Configuration' },
  ];
  const offRail = section ? undefined : OFF_RAIL.find(o => loc.pathname.startsWith(o.match));
  const title = loc.pathname.startsWith('/students/') ? 'Student detail' : (section?.label || offRail?.label || 'CCAT Admin');
  const initials = (me?.display_name || 'CM').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
  const tabs = section?.tabs?.filter(t => !t.perm || can(t.perm)) || [];

  return (
    <div className="shell">
      <nav className={`rail ${drawer ? 'open' : ''}`} aria-label="Primary">
        <button className="railclose" onClick={() => setDrawer(false)} aria-label="Close menu">✕</button>
        <Link to="/" className="brandhdr" aria-label="Dashboard">
          <span className="logo"><span className="cm">CM</span></span>
          <span className="bt"><b>CCAT Admin</b><span>v8.0 · ca-central-1</span></span>
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
            {offRail && <Link to="/" className="backlink">← Dashboard</Link>}
            <span className="title">{title}</span>
          </span>
          <div className="who">
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
