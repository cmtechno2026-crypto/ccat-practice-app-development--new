import type { ReactNode } from 'react';

// Wrap any block to present it in a locked "Coming soon" state: the content stays visible but dimmed,
// greyscaled and non-interactive, under a centered lock pill. Used to show Achievements & Rewards as
// locked for ALL plans until launch without deleting the UI. When `locked` is false, renders children
// untouched (zero overhead), so the same JSX works once the feature ships.
export function ComingSoon({ locked, label = 'Coming soon', children }: { locked: boolean; label?: string; children: ReactNode }) {
  if (!locked) return <>{children}</>;
  return (
    <div style={{ position: 'relative' }}>
      <div aria-hidden style={{ filter: 'grayscale(1) opacity(0.5)', pointerEvents: 'none', userSelect: 'none' }}>
        {children}
      </div>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}>
        <span style={{
          background: 'rgba(30,34,51,0.9)', color: '#fff', fontFamily: "'Baloo 2', system-ui, sans-serif",
          fontWeight: 800, fontSize: 13, borderRadius: 999, padding: '6px 14px',
          boxShadow: '0 8px 20px -8px rgba(0,0,0,0.55)', whiteSpace: 'nowrap',
        }}>🔒 {label}</span>
      </div>
    </div>
  );
}
