// Client-side weak-password HINT + rule helpers (non-blocking hint; the gateway is the authority and will
// 422 with code WEAK_PIN on a weak value). New accounts use a 6–8 char password (any letters/numbers/
// symbols); existing families keep a 4-digit code that still logs in. Mirror of apps/gateway/src/lib/pin.ts
// — the packages share no common TS module, so the list is intentionally duplicated. Keep them in sync.

const COMMON: ReadonlySet<string> = new Set([
  // 4-digit PINs
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

// New-password length policy (existing 4-digit codes are grandfathered at login only).
export const PW_MIN = 6;
export const PW_MAX = 8;

function isAllSame(value: string): boolean {
  for (let i = 1; i < value.length; i++) if (value[i] !== value[0]) return false;
  return value.length > 0;
}

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

// True when a 4–8 char value is too easy to guess. Returns false outside 4–8 so the hint stays quiet.
export function isWeakPin(value: string, dob?: PinDob): boolean {
  if (value.length < 4 || value.length > PW_MAX) return false;
  const v = value.toLowerCase();
  return COMMON.has(v) || isAllSame(value) || isSequential(value) || isDobDerived(value, dob);
}

// The three live rules shown as a checklist on the create-account / reset screens.
export interface PwRules {
  length: boolean; // 6–8 characters
  notWeak: boolean; // not a common/sequential/repeated/birthday value
  all: boolean; // every rule passes
}
export function passwordRules(value: string, dob?: PinDob): PwRules {
  const length = value.length >= PW_MIN && value.length <= PW_MAX;
  // "not weak" only meaningful once it's long enough; treat too-short as failing this rule too.
  const notWeak = length && !isWeakPin(value, dob);
  return { length, notWeak, all: length && notWeak };
}

export const WEAK_PIN_HINT = 'Pick a less common password — avoid 1234, repeats, sequences, or a birthday.';
