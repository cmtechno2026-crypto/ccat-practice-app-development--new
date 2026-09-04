import { MEMBERSHIP_URL, type UpgradeFeature } from '../lib/entitlements';

// Payments Phase 2 — child-safe Upgrade panel. Explains what a membership unlocks and links OUT to
// MEMBERSHIP_URL (a grown-up completes payment on the website). The CCAT app NEVER collects card or
// payment details — there is no form here. Calm, kid-friendly copy; no pressure, no dark patterns.
// Styled with existing classes (card/btn/pill/muted) + inline styles only — no theme.css changes.

const COPY: Record<UpgradeFeature, { icon: string; title: string; line: string }> = {
  practice: { icon: '✏️', title: 'This one is part of a membership', line: "Unlock all practice sets so you can keep learning. Ask a grown-up to set it up." },
  combine: { icon: '🧠', title: 'Battery Combine is part of a membership', line: 'Mixed-battery practice unlocks with a membership. Ask a grown-up to set it up.' },
  exam: { icon: '📝', title: 'Full exams are part of a membership', line: 'Timed mock exams unlock with a membership. Ask a grown-up to set it up.' },
  weekly: { icon: '🗓️', title: 'The Weekly test is part of a membership', line: 'Weekly tests unlock with a membership. Ask a grown-up to set it up.' },
};

export function LockBadge({ label = 'Membership' }: { label?: string }) {
  return (
    <span className="pill" style={{ background: 'var(--tint, #f1eefb)', color: 'var(--muted, #6b7280)' }} aria-label={`Locked — ${label}`}>
      🔒 {label}
    </span>
  );
}

export function UpgradePanel({
  open,
  feature,
  onClose,
}: {
  open: boolean;
  feature: UpgradeFeature;
  requiredTier?: string;
  onClose: () => void;
}) {
  if (!open) return null;
  const c = COPY[feature] ?? COPY.practice;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={c.title}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(20,16,40,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 1000,
      }}
    >
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420, width: '100%', textAlign: 'center' }}>
        <div style={{ fontSize: 40, lineHeight: 1 }} aria-hidden>{c.icon}</div>
        <h2 style={{ marginTop: 10 }}>{c.title}</h2>
        <div className="muted" style={{ marginTop: 6 }}>{c.line}</div>
        <a
          className="btn"
          href={MEMBERSHIP_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ marginTop: 16, display: 'inline-flex', justifyContent: 'center' }}
        >
          Ask a grown-up →
        </a>
        <div style={{ marginTop: 10 }}>
          <button className="btn small secondary" onClick={onClose}>Maybe later</button>
        </div>
      </div>
    </div>
  );
}
