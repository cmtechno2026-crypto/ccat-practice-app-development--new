import { describe, expect, it, vi } from 'vitest';
import { signedAssetUrl, signContentBlocks, verifyAssetSignature } from '../src/lib/assets.js';
import { createStorage } from '../src/services/storage.js';

describe('signed content assets', () => {
  it('accepts the original URL and rejects expired or altered signatures', () => {
    const now = Date.UTC(2026, 7, 30, 12);
    const url = new URL(signedAssetUrl('asset-id', 'https://api.example.test/', 'test-secret', now));
    const expires = url.searchParams.get('expires')!;
    const signature = url.searchParams.get('signature')!;
    expect(verifyAssetSignature('asset-id', expires, signature, 'test-secret', now)).toBe(true);
    expect(verifyAssetSignature('other-id', expires, signature, 'test-secret', now)).toBe(false);
    expect(verifyAssetSignature('asset-id', expires, signature, 'test-secret', now + 3_600_000)).toBe(false);
  });

  it('replaces stored image URLs without changing other blocks', () => {
    const blocks = [{ type: 'text', value: 'Prompt' }, { type: 'image', asset_id: 'asset-id', url: 'stale' }];
    const signed = signContentBlocks(blocks, 'https://api.example.test', 'test-secret') as any[];
    expect(signed[0]).toEqual(blocks[0]);
    expect(signed[1].url).toMatch(/^https:\/\/api\.example\.test\/v1\/content\/assets\/asset-id\?/);
  });
});

describe('Supabase Storage driver', () => {
  it('keeps the secret server-side and uploads/downloads the configured private object', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([7, 8, 9]), { status: 200, headers: { 'content-type': 'image/png' } }));
    const storage = createStorage({
      driver: 'supabase', uploadsDir: '.unused', supabaseUrl: 'https://project.supabase.co/',
      supabaseSecretKey: 'server-secret', supabaseStorageBucket: 'ccat-content', fetchImpl,
    });

    await storage.put('assets/a b.png', Buffer.from([7, 8, 9]), 'image/png');
    const uploaded = fetchImpl.mock.calls[0]!;
    expect(uploaded[0]).toBe('https://project.supabase.co/storage/v1/object/ccat-content/assets/a%20b.png');
    expect((uploaded[1]!.headers as Record<string, string>).authorization).toBe('Bearer server-secret');
    expect((uploaded[1]!.headers as Record<string, string>)['x-upsert']).toBe('false');

    const object = await storage.get('assets/a b.png');
    expect(object?.bytes).toEqual(Buffer.from([7, 8, 9]));
    expect(object?.contentType).toBe('image/png');
  });

  it('returns null for a missing object and fails closed on incomplete configuration', async () => {
    const missing = createStorage({
      driver: 'supabase', uploadsDir: '.unused', supabaseUrl: 'https://project.supabase.co',
      supabaseSecretKey: 'server-secret', fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 })),
    });
    await expect(missing.get('missing.png')).resolves.toBeNull();
    expect(() => createStorage({ driver: 'supabase', uploadsDir: '.unused' })).toThrow(/SUPABASE_URL/);
    expect(() => createStorage({ driver: 'unknown', uploadsDir: '.unused' })).toThrow(/Unknown storage driver/);
  });
});
