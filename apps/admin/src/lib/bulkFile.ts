// Bulk-import file handling for figures: read a chosen file (a plain .md/.txt, OR a .zip containing one
// .md/.txt block file plus the referenced images), match image references to zip entries, upload matched
// images via the EXISTING asset upload path, and attach the resolved assets onto the parsed cards.
//
// Dependency-free ZIP reader: parses the central directory and inflates DEFLATE entries with the browser's
// built-in DecompressionStream('deflate-raw') — no third-party library (keeps the lockfile untouched).

import type { ImportCard, ImgRef } from './importParse';

const PER_IMAGE_MAX = 2 * 1024 * 1024;   // ≤ 2 MB per image
const TOTAL_MAX = 40 * 1024 * 1024;      // ≤ 40 MB of images total
const MAX_IMAGES = 60;                    // sanity cap on image count
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
    if (e.bytes.length > PER_IMAGE_MAX) throw new Error(`"${baseName(e.name)}" is larger than 2 MB.`);
    count++; total += e.bytes.length;
    if (count > MAX_IMAGES) throw new Error(`Too many images in the ZIP (max ${MAX_IMAGES}).`);
    if (total > TOTAL_MAX) throw new Error(`ZIP images exceed the ${TOTAL_MAX / 1024 / 1024} MB total cap.`);
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

// Upload each referenced+matched image ONCE (de-duplicated by basename) via the existing upload fn.
// Returns basename(lowercased) → resolved asset.
export async function uploadImages(
  refs: string[], images: Map<string, BulkImage>,
  upload: (mime: string, b64: string, alt?: string) => Promise<{ id: string; url: string }>,
): Promise<Map<string, ImgRef>> {
  const keys = new Set<string>();
  for (const r of refs) { const k = baseName(r).toLowerCase(); if (images.has(k)) keys.add(k); }
  const out = new Map<string, ImgRef>();
  for (const k of keys) {
    const img = images.get(k)!;
    const r = await upload(img.type, bytesToB64(img.bytes), img.name);
    out.set(k, { asset_id: r.id, url: r.url, alt: '' });
  }
  return out;
}

// Attach resolved assets onto the parsed cards (question figure + option images). Unmatched refs stay null.
export function attachImages(cards: ImportCard[], uploaded: Map<string, ImgRef>): ImportCard[] {
  const pick = (ref?: string | null): ImgRef | null => ref ? (uploaded.get(baseName(ref).toLowerCase()) ?? null) : null;
  return cards.map(c => ({ ...c, img: pick(c.qImageRef), opts: c.opts.map(o => ({ ...o, img: pick(o.imageRef) })) }));
}
