import { useApp } from '../lib/store';

// NGAT workspace tabs (variant B) — the CCAT|NGAT switch styled as a tabbed header, used at the top of the
// Home "ready to practise" card. Shown ONLY for allow-listed accounts (profile.ngat_enabled); otherwise it
// self-hides. On Home, switching just re-scopes the active program — no navigation/drill-down reset needed.
const OPTIONS = [
  { key: 'ccat', label: 'CCAT' },
  { key: 'ngat', label: 'NGAT' },
] as const;

export function WorkspaceTabs() {
  const { program, setProgram, profile } = useApp();
  if (!profile?.ngat_enabled) return null;
  return (
    <div className="ws-tabs" role="group" aria-label="Workspace">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`ws-tab${program === o.key ? ' active' : ''}`}
          aria-pressed={program === o.key}
          onClick={() => setProgram(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
