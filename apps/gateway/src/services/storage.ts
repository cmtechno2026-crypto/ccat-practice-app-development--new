import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Storage service abstraction (Blueprint §36 asset storage). The Gateway depends only on this interface;
// the driver is chosen by config (STORAGE_DRIVER). Local disk for dev; Supabase Storage for production so
// uploaded images survive Render's ephemeral disk across deploys/restarts.

export interface StoredObject { key: string; url: string }
export interface FetchedObject { bytes: Buffer; contentType: string }

export interface StorageService {
  readonly driver: string;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<FetchedObject | null>;
  /** Absolute, client-usable URL for the object (e.g. a public CDN URL), or null when the object must be
   *  served back through the Gateway's own asset route (the local-disk driver). */
  publicUrl(key: string): string | null;
  /** Legacy per-asset-id route (kept for interface compatibility). */
  urlFor(assetId: string): string;
}

/** Local filesystem driver — dev/local parity. Files live under baseDir; served back through the
 *  Gateway's public asset route. NOT for production (Render disk is ephemeral). */
class LocalDiskStorage implements StorageService {
  readonly driver = 'local';
  private meta = new Map<string, string>(); // key -> contentType (best-effort; also stored in DB)
  constructor(private baseDir: string) {}

  private pathFor(key: string) {
    const safe = key.replace(/[^a-zA-Z0-9._/-]/g, '_'); // defensive: keys are app-generated
    return join(this.baseDir, safe);
  }
  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
    this.meta.set(key, contentType);
  }
  async get(key: string): Promise<FetchedObject | null> {
    const p = this.pathFor(key);
    if (!existsSync(p)) return null;
    const bytes = await readFile(p);
    return { bytes, contentType: this.meta.get(key) ?? 'application/octet-stream' };
  }
  publicUrl(): string | null { return null; } // served via the Gateway asset route
  urlFor(assetId: string): string { return `/v1/assets/${assetId}`; }
}

/** Supabase Storage driver — uploads via the Storage REST API using the SERVER-ONLY service-role key,
 *  and returns a stable public URL (bucket must be set public-read in the Supabase dashboard). Uses global
 *  fetch (Node 18+); no SDK dependency. Objects persist independently of the Gateway's disk. */
class SupabaseStorage implements StorageService {
  readonly driver = 'supabase';
  constructor(private baseUrl: string, private serviceKey: string, private bucket: string) {}

  private objectUrl(key: string): string {
    return `${this.baseUrl}/storage/v1/object/${this.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const res = await fetch(this.objectUrl(key), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.serviceKey}`,
        apikey: this.serviceKey,
        'content-type': contentType,
        'x-upsert': 'true',
        'cache-control': '31536000',
      },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Supabase Storage upload failed (${res.status}): ${detail.slice(0, 300)}`);
    }
  }
  async get(key: string): Promise<FetchedObject | null> {
    const res = await fetch(this.publicUrl(key));
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return { bytes: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }
  publicUrl(key: string): string {
    return `${this.baseUrl}/storage/v1/object/public/${this.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  urlFor(assetId: string): string { return `/v1/assets/${assetId}`; }
}

/** Placeholder for a selected-but-unconfigured cloud driver (e.g. s3/gcs). */
class UnconfiguredCloudStorage implements StorageService {
  constructor(public readonly driver: string) {}
  private fail(): never {
    throw new Error(`Storage driver "${this.driver}" is selected but not configured. Implement it in services/storage.ts and set the required credentials.`);
  }
  async put(): Promise<void> { this.fail(); }
  async get(): Promise<FetchedObject | null> { this.fail(); }
  publicUrl(): string | null { return null; }
  urlFor(assetId: string): string { return `/v1/assets/${assetId}`; }
}

export interface StorageOpts {
  driver: string;
  uploadsDir: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  storageBucket?: string;
}

export function createStorage(opts: StorageOpts): StorageService {
  switch (opts.driver) {
    case 'local':
      return new LocalDiskStorage(resolve(opts.uploadsDir));
    case 'supabase':
      if (opts.supabaseUrl && opts.supabaseServiceKey) {
        return new SupabaseStorage(opts.supabaseUrl.replace(/\/$/, ''), opts.supabaseServiceKey, opts.storageBucket || 'assets');
      }
      return new UnconfiguredCloudStorage('supabase'); // env not set → clear error on first use
    case 's3':
    case 'gcs':
      return new UnconfiguredCloudStorage(opts.driver);
    default:
      return new LocalDiskStorage(resolve(opts.uploadsDir));
  }
}
