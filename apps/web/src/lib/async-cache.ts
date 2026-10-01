// Session-lived result cache shared by useAsync (stale-while-revalidate). Lives in its own module so
// both components/ui (the hook) and lib/store (sign-out clear) can use it with no import cycle. In-memory
// only — cleared on full page reload and on sign-out (so a second account in the same tab never sees the
// previous user's cached data).
export const asyncCache = new Map<string, unknown>();
export function clearAsyncCache() { asyncCache.clear(); }
