// Server-authoritative weak-password rejection for account creation and password reset. Passwords are
// 6–8 characters (any letters, numbers, or symbols) for new accounts; existing families keep a 4-digit
// code, which still signs in (login accepts 4–8). This util forbids the easiest-to-guess values at the
// point a password is SET (registration + recovery). It is NOT applied at /v1/auth/login — an existing
// weak code must still be able to sign in and then change it. The function name stays `isWeakPin` for
// call-site stability; it now judges any 4–8 char value, not only a 4-digit PIN. Keep the list in sync
// with the client hint in apps/web/src/lib/pin.ts (the gateway and web packages share no common TS
// module, so the list is intentionally duplicated; the server copy is the authority).

// Common/guessable values: the ~20 worst 4-digit PINs (leaked-frequency) + 2580 (keypad column), plus the
// most common 6–8 char passwords and simple sequences. Compared case-insensitively.
const COMMON: ReadonlySet<string> = new Set([
  // 4-digit PINs (existing users; kept harmless even though new min is 6)
  '1234', '1111', '0000', '1212', '7777', '1004', '2000', '4444', '2222',
  '6969', '9999', '3333', '5555', '6666', '1122', '1313', '8888', '4321',
  '2001', '1010', '2580',
  // 6–8 char common passwords / runs
  '123456', '1234567', '12345678', '654321', '111111', '000000', '121212', '112233',
  'password', 'passwor', 'pass123', 'qwerty', 'qwerty1', 'qwertyui', 'asdfgh', 'zxcvbn',
  'abc123', 'abcabc', 'iloveyou', 'letmein', 'welcome', 'monkey', 'dragon', 'football',
  'princess', 'sunshine', 'starwars', 'trustno1',
]);

export interface PinDob {
  year?: number | null;
  month?: number | null;
  day?: number | null;
}

// Every character identical (0000, aaaa, 111111 …).
function isAllSame(value: string): boolean {
  for (let i = 1; i < value.length; i++) if (value[i] !== value[0]) return false;
  return value.length > 0;
}

// A strict ascending or descending run of consecutive characters by code point (0123, 3456, 9876, abcdef,
// fedcba). Wrap-around is NOT sequential. Works for digits and letters alike.
function isSequential(value: string): boolean {
  if (value.length < 3) return false;
  let asc = true;
  let desc = true;
  for (let i = 1; i < value.length; i++) {
    const prev = value.charCodeAt(i - 1);
    const cur = value.charCodeAt(i);
    if (cur !== prev + 1) asc = false;
    if (cur !== prev - 1) desc = false;
  }
  return asc || desc;
}

// Values a stranger could guess from the child's date of birth: the full birth year (YYYY), the two-digit
// year with the month (MMYY / YYMM), and day/month combos (DDMM / MMDD) when the day is known. Only the
// parts we have are used — the server has month + year at registration/recovery; the web client also has
// the day. Purely numeric candidates, so a mixed-character password never matches.
function isDobDerived(value: string, dob?: PinDob): boolean {
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
  return cand.has(value);
}

// True when a 4–8 character password/PIN is too easy to guess. Length/shape is validated by the request
// schema; this only judges values already in the 4–8 range and returns false for anything else.
export function isWeakPin(value: string, dob?: PinDob): boolean {
  if (value.length < 4 || value.length > 8) return false;
  const v = value.toLowerCase();
  return COMMON.has(v) || isAllSame(value) || isSequential(value) || isDobDerived(value, dob);
}
