import { useCallback, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/store';
import { Avatar } from './Avatar';

// Primary navigation — persistent LEFT sidebar (desktop + tablet). PUSH model: this panel sits in the
// layout flow; expanding widens it AND shifts the content area right (the offset lives on `.main`,
// driven by the `nav-expanded` class the parent puts on `.layout`) so content is never covered. Icons
// keep a FIXED x/y in both states — expanding only fades in the labels to their right and widens the
// panel. Below the mobile breakpoint the same panel becomes an off-canvas drawer (see theme.css).
interface NavItem { label: string; icon: string; to: string; match: (loc: { pathname: string; search: string }) => boolean }

const isExam = (l: { search: string }) => /mode=exam/.test(l.search);
const NAV: NavItem[] = [
  { label: 'Home', icon: '🏠', to: '/home', match: (l) => l.pathname === '/home' },
  { label: 'Practice', icon: '✏️', to: '/practice', match: (l) => (l.pathname === '/practice' && !isExam(l)) || l.pathname.startsWith('/session') || l.pathname.startsWith('/result') },
  { label: 'Exam', icon: '📝', to: '/practice?mode=exam', match: (l) => l.pathname === '/practice' && isExam(l) },
  { label: 'Progress & Analytics', icon: '📊', to: '/progress', match: (l) => l.pathname === '/progress' },
  // Customize temporarily hidden from users — re-enable later (avatar/theme frozen to current selection).
  // { label: 'Customize', icon: '🎨', to: '/customize', match: (l) => l.pathname === '/customize' },
  { label: 'Rewards', icon: '🏅', to: '/rewards', match: (l) => l.pathname === '/rewards' },
  { label: 'Bookmark', icon: '🔖', to: '/bookmarks', match: (l) => l.pathname === '/bookmarks' },
  // Profile removed from the nav list — it's now reached via the user's NAME row in the sidebar footer (below).
  // { label: 'Profile', icon: '👤', to: '/profile', match: (l) => l.pathname === '/profile' },
];

interface SidebarProps {
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
}

// Small open/close delays so a quick mouse pass doesn't flicker the reflow (Case-3 mitigation).
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 200;

export function Sidebar({ expanded, onExpand, onCollapse, drawerOpen, onCloseDrawer }: SidebarProps) {
  const loc = useLocation();
  const nav = useNavigate();
  const { profile, signOut } = useApp();
  const openT = useRef<number | undefined>(undefined);
  const closeT = useRef<number | undefined>(undefined);

  const clearTimers = () => { window.clearTimeout(openT.current); window.clearTimeout(closeT.current); };
  const scheduleOpen = useCallback(() => {
    window.clearTimeout(closeT.current);
    openT.current = window.setTimeout(onExpand, OPEN_DELAY_MS);
  }, [onExpand]);
  const scheduleClose = useCallback(() => {
    window.clearTimeout(openT.current);
    closeT.current = window.setTimeout(onCollapse, CLOSE_DELAY_MS);
  }, [onCollapse]);

  async function logout() { await signOut(); nav('/login', { replace: true }); }

  return (
    <aside
      className={`sidebar${expanded ? ' expanded' : ''}${drawerOpen ? ' drawer-open' : ''}`}
      aria-label="Primary"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocusCapture={() => { clearTimers(); onExpand(); }}
      onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) scheduleClose(); }}
    >
      <div className="sidebar-head">
        {/* Brand header — matches the ADMIN rail: a "CM" tile fixed on the LEFT (the always-visible
            emblem in the collapsed rail) + brand text on the RIGHT ("Concept Mastery" / "CCAT Practice")
            that fades in when the rail expands. Rendered as crisp markup, not a raster. */}
        <Link to="/home" className="brand" aria-label="Concept Mastery — home">
          <span className="brand-tile" aria-hidden>CM</span>
          <span className="brandtext"><strong>Concept Mastery</strong><small>CCAT Practice</small></span>
        </Link>
        {/* Mobile drawer close (CSS-hidden on desktop) */}
        <button type="button" className="sidebar-close" aria-label="Close menu" onClick={onCloseDrawer}>✕</button>
      </div>
      <nav className="snav-list">
        {NAV.map((it) => {
          const active = it.match(loc);
          return (
            <Link key={it.label} to={it.to} title={it.label} className={`snav ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
              <span className="ico" aria-hidden>{it.icon}</span>
              <span className="label">{it.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        {/* The user's NAME row is the entry point to Profile (Profile nav item removed above). */}
        <button className="snav snav-profile" onClick={() => nav('/profile')} aria-label="Open your profile"
          title={`${profile?.display_name ?? 'You'} — open profile`}>
          <span className="ico"><Avatar size={22} /></span>
          <span className="label">{profile?.display_name ?? 'You'}</span>
        </button>
        <button className="snav snav-logout" onClick={logout} title="Log out">
          <span className="ico" aria-hidden>🚪</span>
          <span className="label">Log out</span>
        </button>
      </div>
    </aside>
  );
}
