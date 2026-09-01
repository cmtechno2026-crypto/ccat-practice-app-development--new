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
  const stream = new Blob([bytes]).stream().pipeThrough(new DS('deflate-raw'));
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

// Upload every referenced+matched image ONCE (de-duplicated by basename) in a SINGLE batch request, so ~400
// figures import in one round-trip instead of 400 sequential uploads. `uploadBatch` sends all images together
// (the Gateway stores them with bounded concurrency + one multi-row insert) and returns assets 1:1 with the
// order sent. Returns basename(lowercased) → resolved asset.
export async function uploadImages(
  refs: string[], images: Map<string, BulkImage>,
  uploadBatch: (items: { mime_type: string; data_base64: string; alt_text?: string }[]) => Promise<{ id: string; url: string }[]>,
): Promise<Map<string, ImgRef>> {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of refs) { const k = baseName(r).toLowerCase(); if (images.has(k) && !seen.has(k)) { seen.add(k); keys.push(k); } }
  const out = new Map<string, ImgRef>();
  if (!keys.length) return out;
  const items = keys.map(k => { const img = images.get(k)!; return { mime_type: img.type, data_base64: bytesToB64(img.bytes), alt_text: img.name }; });
  const assets = await uploadBatch(items);
  if (assets.length !== keys.length) throw new Error(`Upload returned ${assets.length} assets for ${keys.length} image(s).`);
  keys.forEach((k, i) => out.set(k, { asset_id: assets[i]!.id, url: assets[i]!.url, alt: '' }));
  return out;
}

// Attach resolved assets onto the parsed cards (question figure + option images). Unmatched refs stay null.
export function attachImages(cards: ImportCard[], uploaded: Map<string, ImgRef>): ImportCard[] {
  const pick = (ref?: string | null): ImgRef | null => ref ? (uploaded.get(baseName(ref).toLowerCase()) ?? null) : null;
  return cards.map(c => ({ ...c, img: pick(c.qImageRef), opts: c.opts.map(o => ({ ...o, img: pick(o.imageRef) })) }));
}
