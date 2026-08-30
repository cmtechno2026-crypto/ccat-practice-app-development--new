import { createHmac, timingSafeEqual } from 'node:crypto';

const ASSET_TTL_SECONDS = 60 * 60;

function signature(assetId: string, expires: number, secret: string): string {
  return createHmac('sha256', `${secret}:asset`).update(`${assetId}.${expires}`).digest('base64url');
}

export function signedAssetUrl(assetId: string, publicUrl: string, secret: string, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + ASSET_TTL_SECONDS;
  const sig = signature(assetId, expires, secret);
  return `${publicUrl.replace(/\/$/, '')}/v1/content/assets/${encodeURIComponent(assetId)}?expires=${expires}&signature=${sig}`;
}

export function verifyAssetSignature(assetId: string, expiresRaw: string | undefined, supplied: string | undefined, secret: string, now = Date.now()): boolean {
  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires) || expires <= Math.floor(now / 1000) || !supplied) return false;
  const expected = signature(assetId, expires, secret);
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signContentBlocks(blocks: unknown, publicUrl: string, secret: string): unknown {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const b = block as Record<string, unknown>;
    return b.type === 'image' && typeof b.asset_id === 'string'
      ? { ...b, url: signedAssetUrl(b.asset_id, publicUrl, secret) }
      : b;
  });
}
