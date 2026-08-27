// Book Store retailer links (Blueprint §21). Destinations must be HTTPS and on an allowlisted
// retailer domain — the app opens these externally, so an open redirect or an off-brand store is
// a safety/policy risk for a children's product. The allowlist below is the DEFAULT curated set
// (Canadian-first, since Concept Mastery is a .ca product); it is a product-policy decision, not a
// hard blueprint mandate, and is intended to be edited here (or moved to config) as retailers change.
export interface RetailerPlatform { key: string; label: string; domains: string[] }

export const RETAILER_ALLOWLIST: RetailerPlatform[] = [
  { key: 'amazon', label: 'Amazon', domains: ['amazon.ca', 'amazon.com'] },
  { key: 'indigo', label: 'Indigo / Chapters', domains: ['indigo.ca', 'chapters.indigo.ca'] },
  { key: 'apple_books', label: 'Apple Books', domains: ['books.apple.com', 'apple.co'] },
  { key: 'google_play', label: 'Google Play Books', domains: ['play.google.com'] },
  { key: 'kobo', label: 'Kobo', domains: ['kobo.com'] },
  { key: 'barnes_noble', label: 'Barnes & Noble', domains: ['barnesandnoble.com'] },
  { key: 'publisher', label: 'Publisher / other (allowlisted)', domains: [] }, // 'other' has no default domains → only usable if an admin adds one below
];

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

// A host is allowed when it equals an allowlisted domain or is a subdomain of one.
export function isAllowlistedRetailerUrl(url: string): { ok: boolean; reason?: string; platform?: string } {
  if (!/^https:\/\//i.test(url)) return { ok: false, reason: 'Retailer URL must be HTTPS' };
  const host = hostOf(url);
  if (!host) return { ok: false, reason: 'Retailer URL is not a valid URL' };
  for (const p of RETAILER_ALLOWLIST) {
    for (const d of p.domains) {
      if (host === d || host.endsWith('.' + d)) return { ok: true, platform: p.key };
    }
  }
  return { ok: false, reason: `Retailer domain "${host}" is not on the allowlist. Allowed: ${allowlistDomains().join(', ')}.` };
}

export function allowlistDomains(): string[] {
  return [...new Set(RETAILER_ALLOWLIST.flatMap((p) => p.domains))];
}
