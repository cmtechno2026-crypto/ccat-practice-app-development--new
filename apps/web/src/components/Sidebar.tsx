import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/store';

// Primary navigation — persistent LEFT sidebar (desktop + tablet, one layout). Replaces the old
// bottom tab bar. Items + icons are the app's real destinations, in the app's order; active item
// uses the mockup's nav colors (#3E7BEE active / #B4BBCF idle).
interface NavItem { label: string; icon: string; to: string; match: (loc: { pathname: string; search: string }) => boolean }

const isExam = (l: { search: string }) => /mode=exam/.test(l.search);
const NAV: NavItem[] = [
  { label: 'Home', icon: '🏠', to: '/home', match: (l) => l.pathname === '/home' },
  { label: 'Practice', icon: '✏️', to: '/practice', match: (l) => (l.pathname === '/practice' && !isExam(l)) || l.pathname.startsWith('/session') || l.pathname.startsWith('/result') },
  { label: 'Exam', icon: '📝', to: '/practice?mode=exam', match: (l) => l.pathname === '/practice' && isExam(l) },
  { label: 'Customize', icon: '🎨', to: '/customize', match: (l) => l.pathname === '/customize' },
  { label: 'Rewards', icon: '🏅', to: '/rewards', match: (l) => l.pathname === '/rewards' || l.pathname === '/progress' },
  { label: 'Bookmark', icon: '🔖', to: '/bookmarks', match: (l) => l.pathname === '/bookmarks' },
  { label: 'Profile', icon: '👤', to: '/profile', match: (l) => l.pathname === '/profile' },
];

export function Sidebar() {
  const loc = useLocation();
  const nav = useNavigate();
  const { profile, signOut } = useApp();
  async function logout() { await signOut(); nav('/login', { replace: true }); }
  return (
    <aside className="sidebar" aria-label="Primary">
      <Link to="/home" className="brand">
        <span className="brand-logo">🦊</span>
        <span className="brandtext"><strong>Concept Mastery</strong><small>CCAT Practice</small></span>
      </Link>
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
        <button className="snav" onClick={() => nav('/profile')} title={profile?.display_name ?? 'You'}>
          <span className="ico" aria-hidden>{profile?.is_preview ? '👀' : '🙂'}</span>
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
