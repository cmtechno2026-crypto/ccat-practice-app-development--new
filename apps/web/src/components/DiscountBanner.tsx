import { usePromo, splitRemaining } from '../lib/promo';

// Gold "50% Off" urgency band with a live Days/Hrs/Min/Sec countdown, in Title Case (Sample A). Renders
// nothing when no promo is live and auto-hides the instant the countdown reaches zero. Display-only.
// Inline styles keep it self-contained (it is portaled into the landing page's #cml-promo slot).
export function DiscountBanner() {
  const promo = usePromo();
  if (!promo.active) return null;
  const t = promo.remaining >= 0 ? splitRemaining(promo.remaining) : null;

  const unit = (v: string, label: string) => (
    <span style={{ background: '#fff', borderRadius: 8, minWidth: 46, textAlign: 'center', padding: '5px 7px', boxShadow: '0 5px 12px -7px rgba(0,0,0,.5)' }}>
      <b style={{ display: 'block', fontFamily: "'Baloo 2', system-ui, sans-serif", fontWeight: 800, fontSize: 18, color: '#1e2233', lineHeight: 1 }}>{v}</b>
      <span style={{ fontSize: 9.5, color: '#6b7180', fontWeight: 700 }}>{label}</span>
    </span>
  );
  const colon = <span style={{ fontFamily: "'Baloo 2', system-ui, sans-serif", fontWeight: 800, fontSize: 16, color: '#3a2600' }}>:</span>;

  return (
    <div style={{ background: 'linear-gradient(90deg,#E8A020,#f6b93b)', color: '#3a2600', padding: '11px 18px',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, flexWrap: 'wrap',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,.5)' }}>
      <span style={{ fontFamily: "'Baloo 2', system-ui, sans-serif", fontWeight: 800, fontSize: 16.5 }}>
        🎉 <b style={{ background: '#3a2600', color: '#ffd889', borderRadius: 7, padding: '1px 9px' }}>{promo.headline}</b>
      </span>
      {t && (
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {unit(t.days, 'Days')}{colon}{unit(t.hrs, 'Hrs')}{colon}{unit(t.min, 'Min')}{colon}{unit(t.sec, 'Sec')}
        </span>
      )}
    </div>
  );
}
