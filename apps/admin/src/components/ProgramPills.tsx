import React from 'react';
import { useAuth } from '../lib/auth';

// Program switcher (CCAT / NGAT / Math Olympiad) — the PROGRAM dimension inside the Practice workspace.
// Distinct from the SITE switcher (Practice / TeacherHub). Drives the shared `program` state in auth,
// which scopes Content, Students, Support, etc. Each program shows a status dot (coloured when active).
type Prog = 'ccat' | 'ngat' | 'math';
const OPTS: { k: Prog; label: string; dot: string }[] = [
  { k: 'ccat', label: 'CCAT', dot: 'var(--brand,#2f6fd0)' },
  { k: 'ngat', label: 'NGAT', dot: 'var(--amber,#e0a030)' },
  { k: 'math', label: 'Math Olympiad', dot: '#E8A020' },
];

export function ProgramPills({ style }: { style?: React.CSSProperties }) {
  const { program, setProgram, allowedPrograms } = useAuth();
  const opts = OPTS.filter(o => allowedPrograms.includes(o.k));
  if (opts.length <= 1) return null; // nothing to switch between (e.g. a single-program teacher)
  return (
    <div role="tablist" aria-label="Program" style={{ display: 'inline-flex', background: 'var(--card2,#eef2f7)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 9, padding: 3, gap: 3, ...style }}>
      {opts.map(o => {
        const on = program === o.k;
        return (
          <button key={o.k} role="tab" aria-selected={on} onClick={() => { if (program !== o.k) setProgram(o.k); }}
            style={{ border: 0, background: on ? 'var(--card,#fff)' : 'transparent', color: on ? 'var(--ink,#15233d)' : 'var(--muted,#647089)', fontWeight: 800, fontSize: 12.5, padding: '6px 12px', borderRadius: 7, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, boxShadow: on ? '0 1px 3px rgba(0,0,0,.10)' : 'none' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: on ? o.dot : 'var(--line,#c3cad8)' }} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
