// Server-authoritative weak-PIN rejection for account creation and PIN reset. A 4-digit PIN has only
// 10,000 possibilities and a small set of them soak up a large share of real-world choices (leaked-PIN
// frequency data), so we forbid the worst offenders at the point a PIN is SET (registration + recovery).
// We deliberately do NOT reject at /v1/auth/login: a student who already has a weak PIN must still be
// able to sign in (and then change it) — login-time rejection would lock them out of their own account.
// Keep the COMMON_PINS list in sync with the client hint in apps/web/src/lib/pin.ts (the gateway and web
// packages share no common TS module, so the list is intentionally duplicated; the server copy is the
// authority, the web copy is only an early hint).

// The ~20 most-common 4-digit PINs by leaked-dataset frequency, plus 2580 (a straight line down a phone
// keypad). all-same-digit and sequential PINs are caught algorithmically below, so a few of these overlap.
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

// All four digits identical (0000, 1111, …). Also present in COMMON_PINS; kept as its own check so the
// rule holds even if the list is trimmed.
function isAllSame(pin: string): boolean {
  return pin[0] === pin[1] && pin[1] === pin[2] && pin[2] === pin[3];
}

// A strict ascending or descending run of consecutive digits (0123, 3456, 9876, 4321). Wrap-around is NOT
// treated as sequential (8901 is allowed). A tiny algorithmic check rather than an enumerated list.
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

// PINs a stranger could guess from the child's date of birth: the full birth year (YYYY), the two-digit
// year combined with the month (MMYY / YYMM), and day/month combos (DDMM / MMDD) when the day is known.
// Whatever parts of the DOB we don't have are simply skipped — the server only has month + year at
// registration/recovery, so the day-based combos apply only when a day is supplied (the web client has it).
function isDobDerived(pin: string, dob?: PinDob): boolean {
  if (!dob) return false;
  const cand = new Set<string>();
  const y = dob.year != null ? Math.trunc(dob.year) : null;
  const m = dob.month != null ? Math.trunc(dob.month) : null;
  const d = dob.day != null ? Math.trunc(dob.day) : null;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (y != null && y > 0) {
    cand.add(String(y)); // full year, e.g. 2016
    const yy = pad(y % 100); // two-digit year, e.g. 16
    if (m != null && m > 0) {
      cand.add(pad(m) + yy);
      cand.add(yy + pad(m));
    }
  }
  if (m != null && m > 0 && d != null && d > 0) {
    cand.add(pad(d) + pad(m)); // DDMM
    cand.add(pad(m) + pad(d)); // MMDD
  }
  return cand.has(pin);
}

// True when a well-formed 4-digit PIN is too easy to guess. Shape (/^\d{4}$/) is validated by the request
// schema; this only judges already-well-formed PINs and returns false for anything else.
export function isWeakPin(pin: string, dob?: PinDob): boolean {
  if (!/^\d{4}$/.test(pin)) return false;
  return COMMON_PINS.has(pin) || isAllSame(pin) || isSequential(pin) || isDobDerived(pin, dob);
}
