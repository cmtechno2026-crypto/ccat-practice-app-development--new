import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Storage service abstraction (Blueprint §36 asset storage). The Gateway depends only on this
// interface; the driver is chosen by config. Supabase Storage is the production implementation;
// its secret key remains inside the Gateway. Local disk is retained only for local development.

export interface StoredObject { key: string; url: string }
export interface FetchedObject { bytes: Buffer; contentType: string }

export interface StorageService {
  readonly driver: string;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<FetchedObject | null>;
  /** Public/relative URL used by clients to fetch the object. */
  urlFor(assetId: string): string;
}

/** Local filesystem driver — dev/local parity. Files live under baseDir; served back through the
 *  Gateway's asset route. Swap for S3/Supabase in production (same interface). */
class LocalDiskStorage implements StorageService {
  readonly driver = 'local';
  private meta = new Map<string, string>(); // key -> contentType (best-effort; also stored in DB)
  constructor(private baseDir: string) {}

  private pathFor(key: string) {
    // prevent path traversal; keys are app-generated but be defensive
    const safe = key.replace(/[^a-zA-Z0-9._/-]/g, '_');
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
  urlFor(assetId: string): string { return `/v1/admin/content/assets/${assetId}`; }
}

/** Placeholder for cloud object storage. Kept as a named seam so production wiring is a drop-in. */
class UnconfiguredCloudStorage implements StorageService {
  constructor(public readonly driver: string) {}
  private fail(): never {
    throw new Error(`Storage driver "${this.driver}" is selected but not configured. Implement it in services/storage.ts (S3/Supabase/GCS) and set the required credentials.`);
  }
  async put(): Promise<void> { this.fail(); }
  async get(): Promise<FetchedObject | null> { this.fail(); }
  urlFor(assetId: string): string { return `/v1/admin/content/assets/${assetId}`; }
}

class SupabaseStorage implements StorageService {
  readonly driver = 'supabase';
  constructor(
    private readonly baseUrl: string,
    private readonly secretKey: string,
    private readonly bucket: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private objectUrl(key: string) {
    const path = key.split('/').map(encodeURIComponent).join('/');
    return `${this.baseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}/${path}`;
  }

  private headers(contentType?: string): Record<string, string> {
    return {
      apikey: this.secretKey,
      authorization: `Bearer ${this.secretKey}`,
      ...(contentType ? { 'content-type': contentType, 'cache-control': '3600', 'x-upsert': 'false' } : {}),
    };
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: 'POST',
      headers: this.headers(contentType),
      body: bytes,
    });
    if (!res.ok) throw new Error(`Supabase Storage upload failed (${res.status})`);
  }

  async get(key: string): Promise<FetchedObject | null> {
    const res = await this.fetchImpl(this.objectUrl(key), { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Supabase Storage download failed (${res.status})`);
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  urlFor(assetId: string): string { return `/v1/content/assets/${assetId}`; }
}

export function createStorage(opts: {
  driver: string;
  uploadsDir: string;
  supabaseUrl?: string;
  supabaseSecretKey?: string;
  supabaseStorageBucket?: string;
  fetchImpl?: typeof fetch;
}): StorageService {
  switch (opts.driver) {
    case 'local':
      return new LocalDiskStorage(resolve(opts.uploadsDir));
    case 'supabase':
      if (!opts.supabaseUrl || !opts.supabaseSecretKey) {
        throw new Error('Supabase Storage requires SUPABASE_URL and SUPABASE_SECRET_KEY');
      }
      return new SupabaseStorage(
        opts.supabaseUrl.replace(/\/$/, ''),
        opts.supabaseSecretKey,
        opts.supabaseStorageBucket ?? 'ccat-content',
        opts.fetchImpl ?? fetch,
      );
    case 's3':
    case 'gcs':
      return new UnconfiguredCloudStorage(opts.driver);
    default:
      throw new Error(`Unknown storage driver "${opts.driver}"`);
  }
}
