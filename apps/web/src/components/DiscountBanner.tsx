import { usePromo, splitRemaining } from '../lib/promo';

// Gold "50% Off" urgency band with a live Days/Hrs/Min/Sec countdown, in Title Case. Renders nothing when
// no promo is live and auto-hides the instant the countdown reaches zero. Display-only.
//
// Used in two ways:
//  - Landing: portaled into #cml-promo (no props) — sits under the sticky header.
//  - In-app (Home, Practice, Plan): rendered inline at the top of the page. Pass `onClick` (+ optional `cta`
//    text) on Home/Practice so the whole bar is a link to the Plan page; omit it on the Plan page itself.
// Inline styles keep it self-contained.
export function DiscountBanner({ onClick, cta }: { onClick?: () => void; cta?: string } = {}) {
  const promo = usePromo();
  if (!promo.active) return null;
  const t = promo.remaining >= 0 ? splitRemaining(promo.remaining) : null;
  const clickable = typeof onClick === 'function';

  const unit = (v: string, label: string) => (
    <span style={{ background: '#fff', borderRadius: 8, minWidth: 46, textAlign: 'center', padding: '5px 7px', boxShadow: '0 5px 12px -7px rgba(0,0,0,.5)' }}>
      <b style={{ display: 'block', fontFamily: "'Baloo 2', system-ui, sans-serif", fontWeight: 800, fontSize: 18, color: '#1e2233', lineHeight: 1 }}>{v}</b>
      <span style={{ fontSize: 9.5, color: '#6b7180', fontWeight: 700 }}>{label}</span>
    </span>
  );
  const colon = <span style={{ fontFamily: "'Baloo 2', system-ui, sans-serif", fontWeight: 800, fontSize: 16, color: '#3a2600' }}>:</span>;

  return (
    <div
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!(); } } : undefined}
      style={{ position: 'relative', background: 'linear-gradient(90deg,#E8A020,#f6b93b)', color: '#3a2600', padding: '11px 18px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, flexWrap: 'wrap',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.5)', cursor: clickable ? 'pointer' : 'default' }}>
      <span style={{ fontFamily: "'Baloo 2', system-ui, sans-serif", fontWeight: 800, fontSize: 16.5 }}>
        🎉 <b style={{ background: '#3a2600', color: '#ffd889', borderRadius: 7, padding: '1px 9px' }}>{promo.headline}</b>
      </span>
      {t && (
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {unit(t.days, 'Days')}{colon}{unit(t.hrs, 'Hrs')}{colon}{unit(t.min, 'Min')}{colon}{unit(t.sec, 'Sec')}
        </span>
      )}
      {clickable && cta && (
        <span style={{ fontFamily: "'Baloo 2', system-ui, sans-serif", fontWeight: 800, fontSize: 12.5, color: '#3a2600',
          background: 'rgba(255,255,255,.5)', borderRadius: 999, padding: '4px 11px', whiteSpace: 'nowrap' }}>{cta}</span>
      )}
    </div>
  );
}
