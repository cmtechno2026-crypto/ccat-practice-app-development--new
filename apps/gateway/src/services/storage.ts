import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Storage service abstraction (Blueprint §36 asset storage). The Gateway depends only on this
// interface; the driver is chosen by config so moving from local disk to S3 / Supabase Storage /
// GCS at global-deploy time is a config change, not a code change. Content-addressed keys keep it
// CDN-friendly. Only the local-disk driver is implemented now; cloud drivers throw a clear
// "not configured" error until wired, leaving the seam ready.

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

export function createStorage(opts: { driver: string; uploadsDir: string }): StorageService {
  switch (opts.driver) {
    case 'local':
      return new LocalDiskStorage(resolve(opts.uploadsDir));
    case 's3':
    case 'supabase':
    case 'gcs':
      return new UnconfiguredCloudStorage(opts.driver);
    default:
      return new LocalDiskStorage(resolve(opts.uploadsDir));
  }
}
