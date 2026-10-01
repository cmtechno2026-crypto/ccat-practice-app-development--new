import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/store';

// NGAT workspace switcher — a small segmented pill [ CCAT · NGAT ] shown in the Sidebar header (and the
// mobile drawer, since the drawer IS the sidebar). Mirrors the admin console's CCAT|TeacherHub control.
// Rendered ONLY for allow-listed accounts (profile.ngat_enabled); everyone else sees the app exactly as
// before. Switching only changes which PROGRAM the scoped screens (Practice/Exam/Assignments/Progress)
// read — shared screens (Home chrome, Profile, Achievements, My Plan) are unaffected.
const OPTIONS: { key: 'ccat' | 'ngat'; label: string }[] = [
  { key: 'ccat', label: 'CCAT' },
  { key: 'ngat', label: 'NGAT' },
];

export function WorkspaceSwitch() {
  const { program, setProgram, profile } = useApp();
  const nav = useNavigate();
  const loc = useLocation();

  // Gate: only accounts entitled to NGAT see the switcher at all.
  if (!profile?.ngat_enabled) return null;

  const switchTo = (p: 'ccat' | 'ngat') => {
    if (p === program) return;
    setProgram(p);
    // Reset any in-progress drill-down so the new workspace opens on a clean landing:
    //  • mid-session/result → go Home (that session belongs to the other workspace's content)
    //  • Practice/Exam → keep the mode, drop battery/category/set
    if (loc.pathname.startsWith('/session') || loc.pathname.startsWith('/result')) { nav('/home'); return; }
    if (loc.pathname === '/practice') {
      const mode = new URLSearchParams(loc.search).get('mode');
      nav(mode ? `/practice?mode=${mode}` : '/practice', { replace: true });
    }
  };

  return (
    <div className="ws-switch" role="group" aria-label="Workspace">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`ws-seg${program === o.key ? ' active' : ''}`}
          aria-pressed={program === o.key}
          onClick={() => switchTo(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
