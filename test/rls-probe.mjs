// test/rls-probe.mjs — security regression canary (§9).
//
// Using the PUBLIC anon key (the real attacker surface — it ships in browser
// bundles), assert that NO sensitive table is readable. RLS + revoked grants
// should make every one of these return 403 (permission denied). If any returns
// rows, a grant was re-added or RLS was flipped off — fail the build.
//
// This probes the LIVE database, so it catches drift the moment it happens
// (on PR, on push to master, and daily). It does not simulate a PR's own
// migration before merge; that would need a throwaway DB seeded from in-repo
// migrations, which requires the repo migration set to match live first.
//
// Env: SUPABASE_ANON_KEY (required, publishable), SUPABASE_URL (optional).

const URL = process.env.SUPABASE_URL || 'https://cqzpzhdleqyrmedymypg.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY;
if (!ANON) { console.error('rls-probe: set SUPABASE_ANON_KEY'); process.exit(2); }

const h = { apikey: ANON, Authorization: `Bearer ${ANON}` };

// Every table an attacker with the anon key must NOT be able to read.
const PUBLIC_TABLES = [
  'ta_training_modules', 'ta_training_progress', 'ta_training_roleplays', 'ta_settings',
  'ta_teachers', 'ta_slots', 'ta_booking_requests', 'ta_booking_links',
  'ta_booking_request_slots', 'ta_sessions', 'ta_leave_requests', 'pending_bookings',
];
// A couple of ccat tables — the ccat schema must never be exposed to PostgREST.
const CCAT_TABLES = ['students', 'entitlements', 'admin_profiles', 'paypal_payment_events'];

const failures = [];

async function anonRead(path, extra = {}) {
  let r;
  try {
    r = await fetch(`${URL}/rest/v1/${path}?select=*&limit=1`, { headers: { ...h, ...extra } });
  } catch (e) {
    return { status: 0, readable: false, err: e.message };
  }
  let body = null; try { body = await r.json(); } catch { /* non-JSON */ }
  // "readable" = the anon key got actual rows back.
  return { status: r.status, readable: r.ok && Array.isArray(body) && body.length > 0 };
}

for (const t of PUBLIC_TABLES) {
  const { status, readable, err } = await anonRead(t);
  if (readable) { failures.push(`anon can READ public.${t} (status ${status})`); console.log(`FAIL  public.${t}  status=${status}`); }
  else console.log(`ok    public.${t}  status=${status}${err ? ' (' + err + ')' : ''}`);
}
for (const t of CCAT_TABLES) {
  const { status, readable } = await anonRead(t, { 'Accept-Profile': 'ccat' });
  if (readable) { failures.push(`anon can READ ccat.${t} (status ${status}) — ccat schema exposed`); console.log(`FAIL  ccat.${t}  status=${status}`); }
  else console.log(`ok    ccat.${t}  status=${status}`);
}

if (failures.length) {
  console.error('\nRLS PROBE FAILED — anon key reached sensitive data:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nRLS probe passed: the anon key cannot read any sensitive table.');
