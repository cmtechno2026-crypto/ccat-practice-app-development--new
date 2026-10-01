import React from 'react';
import { useAuth } from '../lib/auth';

// Program (CCAT / NGAT) switcher — the PROGRAM dimension, distinct from the SITE switcher
// (CCAT Practice / TeacherHub) in Layout. Drives the shared `program` state in auth. Rendered as
// in-page pills on the Content / Exam / Import pages (admins) and in the TeacherHub-free teacher top bar.
export function ProgramPills({ style }: { style?: React.CSSProperties }) {
  const { program, setProgram } = useAuth();
  const opts: { k: 'ccat' | 'ngat'; label: string }[] = [{ k: 'ccat', label: 'CCAT' }, { k: 'ngat', label: 'NGAT' }];
  return (
    <div role="tablist" aria-label="Program" style={{ display: 'inline-flex', background: 'var(--card2,#eef2f7)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 9, padding: 3, gap: 3, ...style }}>
      {opts.map(o => {
        const on = program === o.k;
        return (
          <button key={o.k} role="tab" aria-selected={on} onClick={() => { if (program !== o.k) setProgram(o.k); }}
            style={{ border: 0, background: on ? 'var(--card,#fff)' : 'transparent', color: on ? 'var(--primary,#1A5EAB)' : 'var(--muted,#647089)', fontWeight: 800, fontSize: 12.5, padding: '6px 12px', borderRadius: 7, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, boxShadow: on ? '0 1px 3px rgba(0,0,0,.10)' : 'none' }}>
            {on && <span style={{ width: 7, height: 7, borderRadius: '50%', background: o.k === 'ngat' ? 'var(--amber,#e0a030)' : 'var(--brand,#2f6fd0)' }} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
