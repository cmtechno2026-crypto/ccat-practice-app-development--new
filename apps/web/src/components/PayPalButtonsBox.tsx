import { useEffect, useRef, useState } from 'react';
import { loadPayPalSdk } from '../lib/paypal';

// Renders PayPal Smart Buttons (PayPal + Debit/Credit Card) that open PayPal in a popup over the current
// page — the in-context checkout. The parent stays on our branded page; no full-page redirect.
//
//  createOrder → resolve with the PayPal order id (our gateway creates it and returns { id }).
//  onApprove   → called with the approved order id; capture it, then continue the flow.
//  onCancel    → the buyer closed the popup without paying.
//  onError     → SDK/network error (message is safe to show).
//
// Callers only mount this when PAYPAL_INCONTEXT is true; otherwise they use the redirect flow.
export function PayPalButtonsBox({
  createOrder,
  onApprove,
  onCancel,
  onError,
}: {
  createOrder: () => Promise<string>;
  onApprove: (orderId: string) => Promise<void>;
  onCancel?: () => void;
  onError?: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep the latest callbacks in a ref so the buttons (rendered once) always call current props.
  const cbRef = useRef({ createOrder, onApprove, onCancel, onError });
  cbRef.current = { createOrder, onApprove, onCancel, onError };

  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let instance: any = null;

    loadPayPalSdk()
      .then((paypal) => {
        if (cancelled || !containerRef.current) return;
        instance = paypal.Buttons({
          style: { layout: 'vertical', color: 'gold', shape: 'pill', label: 'pay', height: 46 },
          createOrder: () => cbRef.current.createOrder(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onApprove: (data: any) => cbRef.current.onApprove(data.orderID),
          onCancel: () => cbRef.current.onCancel?.(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onError: (err: any) => cbRef.current.onError?.(String(err?.message || err || 'Payment error')),
        });
        instance
          .render(containerRef.current)
          .then(() => { if (!cancelled) setLoading(false); })
          .catch(() => { if (!cancelled) { setFailed(true); setLoading(false); } });
      })
      .catch(() => { if (!cancelled) { setFailed(true); setLoading(false); } });

    return () => {
      cancelled = true;
      try { instance?.close?.(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div ref={containerRef} />
      {loading && !failed && (
        <div style={{ textAlign: 'center', fontSize: 13, color: '#8a90a6', fontWeight: 700, padding: '10px 0' }}>
          Loading secure checkout…
        </div>
      )}
      {failed && (
        <div style={{ color: '#c0392b', fontSize: 13, fontWeight: 700, textAlign: 'center', padding: '6px 0' }}>
          Couldn’t load the payment form. Please refresh and try again.
        </div>
      )}
    </div>
  );
}
