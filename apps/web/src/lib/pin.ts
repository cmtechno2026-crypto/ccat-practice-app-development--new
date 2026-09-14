// Client-side weak-PIN HINT only (non-blocking). The gateway is the authority
// (apps/gateway/src/lib/pin.ts) and will 422 with code WEAK_PIN if a weak PIN is submitted; this mirrors
// its rules so the parent gets an early nudge while typing. Keep the two copies in sync — the packages
// share no common TS module, so the list is intentionally duplicated.

export const COMMON_PINS: ReadonlySet<string> = new Set([
  '1234', '1111', '0000', '1212', '7777', '1004', '2000', '4444', '2222',
  '6969', '9999', '3333', '5555', '6666', '1122', '1313', '8888', '4321',
  '2001', '1010', '2580',
]);

export interface PinDob {
  year?: number | null;
  month?: number | null;
  day?: number | null;
}

function isAllSame(pin: string): boolean {
  return pin[0] === pin[1] && pin[1] === pin[2] && pin[2] === pin[3];
}

function isSequential(pin: string): boolean {
  let asc = true;
  let desc = true;
  for (let i = 1; i < pin.length; i++) {
    const prev = pin.charCodeAt(i - 1);
    const cur = pin.charCodeAt(i);
    if (cur !== prev + 1) asc = false;
    if (cur !== prev - 1) desc = false;
  }
  return asc || desc;
}

function isDobDerived(pin: string, dob?: PinDob): boolean {
  if (!dob) return false;
  const cand = new Set<string>();
  const y = dob.year != null ? Math.trunc(dob.year) : null;
  const m = dob.month != null ? Math.trunc(dob.month) : null;
  const d = dob.day != null ? Math.trunc(dob.day) : null;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (y != null && y > 0) {
    cand.add(String(y));
    const yy = pad(y % 100);
    if (m != null && m > 0) {
      cand.add(pad(m) + yy);
      cand.add(yy + pad(m));
    }
  }
  if (m != null && m > 0 && d != null && d > 0) {
    cand.add(pad(d) + pad(m));
    cand.add(pad(m) + pad(d));
  }
  return cand.has(pin);
}

// True when a complete 4-digit PIN is too easy to guess. Returns false for partial input so the hint only
// appears once all four digits are entered.
export function isWeakPin(pin: string, dob?: PinDob): boolean {
  if (!/^\d{4}$/.test(pin)) return false;
  return COMMON_PINS.has(pin) || isAllSame(pin) || isSequential(pin) || isDobDerived(pin, dob);
}

// Standard hint copy for a weak PIN (shared by the register + recovery screens).
export const WEAK_PIN_HINT = 'Pick a less common PIN — avoid 1234, repeats, or a birthday.';
