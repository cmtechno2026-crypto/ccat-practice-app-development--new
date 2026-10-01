// Bulk-import file handling for figures: read a chosen file (a plain .md/.txt, OR a .zip containing one
// .md/.txt block file plus the referenced images), match image references to zip entries, upload matched
// images via the EXISTING asset upload path, and attach the resolved assets onto the parsed cards.
//
// Dependency-free ZIP reader: parses the central directory and inflates DEFLATE entries with the browser's
// built-in DecompressionStream('deflate-raw') — no third-party library (keeps the lockfile untouched).

import type { ImportCard, ImgRef } from './importParse';

// Bulk-add ZIP limits (mirror the Gateway's batch-upload caps). Named single constants; enforced client-side
// in readBulkInput BEFORE any upload, so an over-limit zip is rejected with a clear message.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;        // ≤ 3 MB per image
const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024;   // ≤ 50 MB of images total
const MAX_IMAGES_PER_ZIP = 400;                 // ≤ 400 images per zip
const OVER_LIMIT_MSG = 'Max 400 images / 50 MB per upload — split into more zips.';
const IMG_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export function baseName(p: string): string { return (p.split(/[\\/]/).pop() ?? p).trim(); }
export function mimeFromName(name: string): string | null {
  const ext = baseName(name).split('.').pop()?.toLowerCase() ?? '';
  return IMG_EXT[ext] ?? null; // png/jpg/jpeg/webp only — svg and others are not an allowed figure type
}

export type ZipEntry = { name: string; bytes: Uint8Array };

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as any).DecompressionStream;
  if (!DS) throw new Error('This browser cannot read compressed ZIPs — use a newer browser, or store images uncompressed.');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DS('deflate-raw'));
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

// Parse a ZIP via its central directory. Returns file entries (directories skipped).
export async function unzip(buf: ArrayBuffer): Promise<ZipEntry[]> {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const dec = new TextDecoder();
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('Not a valid ZIP file (no end-of-central-directory record).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.byteLength || dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 32, true);
    const commentLen = dv.getUint16(p + 34, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    if (!name.endsWith('/') && dv.getUint32(localOff, true) === 0x04034b50) {
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = u8.subarray(dataStart, dataStart + compSize);
      let bytes: Uint8Array;
      if (method === 0) bytes = comp.slice();
      else if (method === 8) bytes = await inflateRaw(comp);
      else throw new Error(`Unsupported ZIP compression for "${baseName(name)}" (method ${method}).`);
      out.push({ name, bytes });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export type BulkImage = { name: string; bytes: Uint8Array; type: string };
export type BulkInput = { text: string; images: Map<string, BulkImage> }; // images keyed by lowercased basename

// Read the chosen file. Plain text → the text with no images (behaves exactly as before). ZIP → the single
// .md/.txt block file as text plus its image entries (root or images/ folder), validated for type/size.
export async function readBulkInput(file: File): Promise<BulkInput> {
  const isZip = /\.zip$/i.test(file.name) || /zip/i.test(file.type || '');
  if (!isZip) return { text: await file.text(), images: new Map() };

  const entries = await unzip(await file.arrayBuffer());
  const textEntries = entries.filter(e => /\.(md|txt)$/i.test(e.name)).sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  if (textEntries.length === 0) throw new Error('The ZIP has no .md or .txt question file.');
  const text = new TextDecoder().decode(textEntries[0].bytes);

  const images = new Map<string, BulkImage>();
  let total = 0, count = 0;
  for (const e of entries) {
    const type = mimeFromName(e.name);
    if (!type) continue; // ignore non-image / non-text (e.g. svg, readme images we don't support)
    if (e.bytes.length > MAX_IMAGE_BYTES) throw new Error(`"${baseName(e.name)}" is larger than 3 MB — max 3 MB per image.`);
    count++; total += e.bytes.length;
    if (count > MAX_IMAGES_PER_ZIP) throw new Error(OVER_LIMIT_MSG);
    if (total > MAX_ZIP_TOTAL_BYTES) throw new Error(OVER_LIMIT_MSG);
    images.set(baseName(e.name).toLowerCase(), { name: baseName(e.name), bytes: e.bytes, type });
  }
  return { text, images };
}

export type MatchResult = { referenced: string[]; matched: string[]; missing: string[]; unused: string[] };
export function matchImages(refs: string[], images: Map<string, BulkImage>): MatchResult {
  const used = new Set<string>();
  const matched: string[] = [], missing: string[] = [];
  for (const r of refs) { const k = baseName(r).toLowerCase(); if (images.has(k)) { matched.push(r); used.add(k); } else missing.push(r); }
  const unused: string[] = [];
  for (const [k, img] of images) if (!used.has(k)) unused.push(img.name);
  return { referenced: refs, matched, missing, unused };
}

function bytesToB64(bytes: Uint8Array): string {
  let s = ''; const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  return btoa(s);
}

// #2 CLIENT COMPRESSION: downscale oversized figures and re-encode to WebP before upload. Shrinks what gets
// stored (non-verbal line art compresses hard) and the upload payload itself. Fully defensive — if the browser
// can't decode/encode, or WebP isn't actually smaller, the original bytes/type are kept unchanged.
const COMPRESS_MAX_DIM = 900;        // longest side cap (px) — ample for CCAT/NGAT figures
const COMPRESS_WEBP_QUALITY = 0.85;

async function normalizeImage(bytes: Uint8Array, type: string): Promise<{ bytes: Uint8Array; type: string }> {
  try {
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return { bytes, type };
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type }));
    const scale = Math.min(1, COMPRESS_MAX_DIM / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bmp.close?.(); return { bytes, type }; }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const out: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/webp', COMPRESS_WEBP_QUALITY));
    if (!out) return { bytes, type };
    const outBytes = new Uint8Array(await out.arrayBuffer());
    return outBytes.length < bytes.length ? { bytes: outBytes, type: 'image/webp' } : { bytes, type };
  } catch { return { bytes, type }; }
}

// Per-request upload chunk caps. A single huge request (all figures' base64 in one POST) is rejected as 413
// by the JSON body limit / edge proxy, so the referenced images are uploaded in bounded CHUNKS. Each chunk is
// still stored server-side with bounded concurrency + one multi-row insert; results are stitched back in order.
const UPLOAD_CHUNK_MAX_BYTES = 10 * 1024 * 1024; // ≤ 10 MB of base64 per request (gateway JSON limit is 16 MB)
const UPLOAD_CHUNK_MAX_IMAGES = 40;             // …and at most 40 images per request
const UPLOAD_CHUNK_PARALLEL = 3;                 // chunks uploaded concurrently (bounded)

// Upload every referenced+matched image ONCE (de-duplicated by basename), in size-bounded batches so a large
// figure set imports reliably instead of failing a single oversized request. `uploadBatch` sends one chunk
// (the Gateway stores it with bounded concurrency + one multi-row insert) and returns assets 1:1 with the
// order sent. Returns basename(lowercased) → resolved asset.
// Direct-to-storage upload API (gateway mints signed URLs; browser PUTs bytes straight to storage).
export type DirectUploadApi = {
  sign: (images: { ext: string; mime_type: string; checksum: string; alt_text?: string }[]) => Promise<{
    supported: boolean;
    items?: { existing?: { id: string; url: string }; upload?: { key: string; uploadUrl: string } }[];
  }>;
  register: (assets: { key: string; mime_type: string; checksum: string; byte_size: number; width?: number | null; height?: number | null; alt_text?: string }[]) => Promise<{ assets: { id: string; url: string }[] }>;
};

// Upload every referenced+matched image ONCE (de-duplicated by CONTENT), attaching the resolved assets.
// Prefers DIRECT-TO-STORAGE (browser -> Supabase Storage via signed URLs, so the gateway never buffers the
// bytes); falls back to the server batch path when the driver can't sign (local dev) or signing is down.
export async function uploadImages(
  refs: string[], images: Map<string, BulkImage>,
  uploadBatch: (items: { mime_type: string; data_base64: string; alt_text?: string }[]) => Promise<{ id: string; url: string }[]>,
  direct?: DirectUploadApi,
): Promise<Map<string, ImgRef>> {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of refs) { const k = baseName(r).toLowerCase(); if (images.has(k) && !seen.has(k)) { seen.add(k); keys.push(k); } }
  const out = new Map<string, ImgRef>();
  if (!keys.length) return out;

  const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
    const subtle = (globalThis.crypto as { subtle?: SubtleCrypto } | undefined)?.subtle;
    if (!subtle) return `len:${bytes.length}`; // fallback: no content-dedup, but still correct
    const copy = bytes.slice();
    const d = await subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
    return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  const extFromMime = (m: string): string => (m === 'image/png' ? 'png' : m === 'image/webp' ? 'webp' : 'jpg');

  // Normalize + content-hash each unique-by-name image; DEDUPE BY CONTENT so an identical picture reused
  // across many questions uploads once and is shared by every reference (the big lever on reasoning papers).
  type U = { mime: string; bytes: Uint8Array; hash: string; ext: string; alt: string };
  const keyToHash = new Map<string, string>();
  const hashToIndex = new Map<string, number>();
  const uniq: U[] = [];
  for (const k of keys) {
    const img = images.get(k)!;
    const norm = await normalizeImage(img.bytes, img.type);
    const hash = await sha256Hex(norm.bytes);
    keyToHash.set(k, hash);
    if (!hashToIndex.has(hash)) {
      hashToIndex.set(hash, uniq.length);
      uniq.push({ mime: norm.type, bytes: norm.bytes, hash, ext: extFromMime(norm.type), alt: img.name });
    }
  }
  const hashToAsset = new Map<string, ImgRef>();

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        const st = (e as { status?: number } | undefined)?.status;
        const transient = st === undefined || st >= 500 || st === 429 || st === 408;
        if (!transient || attempt >= 3) throw e;
        await sleep(2000 * Math.pow(2, attempt)); // 2s, 4s, 8s
      }
    }
  };

  // ---- DIRECT-TO-STORAGE PATH (production) ----
  let directDone = false;
  if (direct) {
    let sign: Awaited<ReturnType<DirectUploadApi['sign']>> | null = null;
    try { sign = await withRetry(() => direct.sign(uniq.map((u) => ({ ext: u.ext, mime_type: u.mime, checksum: u.hash, alt_text: u.alt })))); }
    catch { sign = null; } // signing unreachable -> fall through to server batch
    if (sign && sign.supported && sign.items && sign.items.length === uniq.length) {
      const putTasks: { idx: number; key: string; uploadUrl: string }[] = [];
      sign.items.forEach((it, i) => {
        if (it.existing) hashToAsset.set(uniq[i]!.hash, { asset_id: it.existing.id, url: it.existing.url, alt: '' });
        else if (it.upload) putTasks.push({ idx: i, key: it.upload.key, uploadUrl: it.upload.uploadUrl });
      });
      const PAR = 12; // direct PUTs are light (one object each) and go to storage, not the gateway
      for (let i = 0; i < putTasks.length; i += PAR) {
        const wave = putTasks.slice(i, i + PAR);
        await Promise.all(wave.map((t) => withRetry(async () => {
          const u = uniq[t.idx]!;
          const res = await fetch(t.uploadUrl, { method: 'PUT', headers: { 'content-type': u.mime, 'x-upsert': 'true' }, body: u.bytes as BlobPart });
          if (!res.ok) { const err = new Error(`storage upload ${res.status}`) as Error & { status?: number }; err.status = res.status; throw err; }
        })));
      }
      if (putTasks.length) {
        const reg = await withRetry(() => direct.register(putTasks.map((t) => ({
          key: t.key, mime_type: uniq[t.idx]!.mime, checksum: uniq[t.idx]!.hash, byte_size: uniq[t.idx]!.bytes.length, alt_text: uniq[t.idx]!.alt,
        }))));
        if (!reg.assets || reg.assets.length !== putTasks.length) throw new Error(`Register returned ${reg.assets?.length ?? 0} assets for ${putTasks.length} upload(s).`);
        putTasks.forEach((t, j) => hashToAsset.set(uniq[t.idx]!.hash, { asset_id: reg.assets[j]!.id, url: reg.assets[j]!.url, alt: '' }));
      }
      directDone = true;
    }
  }

  // ---- FALLBACK: server batch path (local dev / signing unavailable) ----
  if (!directDone) {
    type Item = { mime_type: string; data_base64: string; alt_text?: string };
    const items: Item[] = uniq.map((u) => ({ mime_type: u.mime, data_base64: bytesToB64(u.bytes), alt_text: u.alt }));
    const chunks: { start: number; items: Item[] }[] = [];
    { let cur: Item[] = []; let curBytes = 0; let start = 0;
      for (let i = 0; i < items.length; i++) {
        const sz = items[i]!.data_base64.length;
        if (cur.length && (cur.length >= UPLOAD_CHUNK_MAX_IMAGES || curBytes + sz > UPLOAD_CHUNK_MAX_BYTES)) {
          chunks.push({ start, items: cur }); cur = []; curBytes = 0; start = i;
        }
        cur.push(items[i]!); curBytes += sz;
      }
      if (cur.length) chunks.push({ start, items: cur });
    }
    for (let i = 0; i < chunks.length; i += UPLOAD_CHUNK_PARALLEL) {
      const wave = chunks.slice(i, i + UPLOAD_CHUNK_PARALLEL);
      await Promise.all(wave.map(async (ch) => {
        const assets = await withRetry(() => uploadBatch(ch.items));
        if (assets.length !== ch.items.length) throw new Error(`Upload returned ${assets.length} assets for ${ch.items.length} image(s).`);
        assets.forEach((a, j) => { hashToAsset.set(uniq[ch.start + j]!.hash, { asset_id: a.id, url: a.url, alt: '' }); });
      }));
    }
  }

  for (const k of keys) { const a = hashToAsset.get(keyToHash.get(k)!); if (a) out.set(k, a); }
  return out;
}

// Prepare a single picked File for upload through the normal asset endpoint — same #2 compression
// (downscale + WebP) as the bulk path, so manually-added stem/option figures are optimized too.
export async function prepareImageUpload(file: File): Promise<{ mime_type: string; data_base64: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const norm = await normalizeImage(bytes, file.type);
  return { mime_type: norm.type, data_base64: bytesToB64(norm.bytes) };
}

// Attach resolved assets onto the parsed cards (question figure + option images). Unmatched refs stay null.
export function attachImages(cards: ImportCard[], uploaded: Map<string, ImgRef>): ImportCard[] {
  const pick = (ref?: string | null): ImgRef | null => ref ? (uploaded.get(baseName(ref).toLowerCase()) ?? null) : null;
  return cards.map(c => ({ ...c, img: pick(c.qImageRef), opts: c.opts.map(o => ({ ...o, img: pick(o.imageRef) })) }));
}
