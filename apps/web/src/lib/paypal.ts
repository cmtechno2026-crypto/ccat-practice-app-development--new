// PayPal JS SDK loader for in-context (popup) checkout.
//
// When VITE_PAYPAL_CLIENT_ID is set, checkout renders PayPal Smart Buttons that open PayPal in a
// popup ON TOP of our own page — the parent never does a full-page jump to paypal.com. When the id is
// NOT set, PAYPAL_INCONTEXT is false and every caller falls back to the existing approve-URL redirect,
// so the app behaves EXACTLY as before until the client id is configured. This makes the popup safe to
// ship incrementally: no env var → no behaviour change.
//
// Set VITE_PAYPAL_CLIENT_ID in the web app's build env (same place VITE_PAYMENTS_ENABLED lives). Use the
// LIVE client id in production and the sandbox client id when testing. The client id is public by design
// (it ships in the browser bundle); the secret stays only on the gateway.

export const PAYPAL_CLIENT_ID: string = String(
  (import.meta.env.VITE_PAYPAL_CLIENT_ID as string | undefined) ?? '',
).trim().replace(/^['"]+|['"]+$/g, '');

// True when we should render in-context buttons. When false, callers keep the redirect flow.
export const PAYPAL_INCONTEXT: boolean = PAYPAL_CLIENT_ID.length > 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PayPalNamespace = any;

let sdkPromise: Promise<PayPalNamespace> | null = null;

// Inject the PayPal SDK <script> once and resolve with window.paypal. Rejects if the id is missing or
// the script fails to load (callers then fall back to the redirect).
export function loadPayPalSdk(): Promise<PayPalNamespace> {
  if (!PAYPAL_INCONTEXT) return Promise.reject(new Error('PAYPAL_CLIENT_ID not set'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = (window as any).paypal;
  if (existing) return Promise.resolve(existing);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      'client-id': PAYPAL_CLIENT_ID,
      currency: 'CAD',
      intent: 'capture',
      components: 'buttons',
      'enable-funding': 'card', // show the "Debit or Credit Card" button alongside PayPal
    });
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
    s.async = true;
    s.onload = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pp = (window as any).paypal;
      if (pp) resolve(pp);
      else { sdkPromise = null; reject(new Error('PayPal SDK loaded but window.paypal missing')); }
    };
    s.onerror = () => { sdkPromise = null; reject(new Error('Failed to load PayPal SDK')); };
    document.head.appendChild(s);
  });
  return sdkPromise;
}
