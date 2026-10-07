import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Study Material render pipeline (server-side, inside the gateway). Owner decision: strongest real
// hard-block. The ORIGINAL file and the raw page images never reach the browser; the student only
// ever receives per-page images that are watermarked with their identity at request time. This
// cannot stop screenshots — nothing in a browser can — but the source bytes stay on the server.
//
// Tools (installed in the gateway Docker image): LibreOffice headless (pptx→pdf), poppler
// `pdftoppm` (pdf→page PNGs), ImageMagick `convert` (per-request watermark composite).

const exec = promisify(execFile);

export type SourceKind = 'pdf' | 'pptx';

export interface RasterResult {
  pageCount: number;
  pages: { index: number; png: Buffer }[];
}

const RENDER_DPI = Number(process.env.STUDY_RENDER_DPI || 120); // 120 is crisp for text workbooks; smaller + faster than 150
const MAX_PAGES = Number(process.env.STUDY_MAX_PAGES || 400); // safety cap
const SOFFICE_TIMEOUT_MS = 180_000;
const PDFTOPPM_TIMEOUT_MS = 180_000;
const CONVERT_TIMEOUT_MS = 30_000;
const BIG_BUFFER = 64 * 1024 * 1024;
// fonts-dejavu-core installs this path; overridable for other fonts.
const FONT = process.env.WATERMARK_FONT || '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

/** Classify an upload as a supported source, or null if unsupported. */
export function sourceKindOf(mime: string, fileName?: string): SourceKind | null {
  const m = (mime || '').toLowerCase();
  const n = (fileName || '').toLowerCase();
  if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (
    m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    m === 'application/vnd.ms-powerpoint' ||
    n.endsWith('.pptx') ||
    n.endsWith('.ppt')
  ) return 'pptx';
  return null;
}

/** Convert a source file (pdf or pptx) into an ordered array of base page PNG buffers. */
export async function rasterizeSource(bytes: Buffer, kind: SourceKind): Promise<RasterResult> {
  const dir = await mkdtemp(join(tmpdir(), 'studymat-'));
  try {
    let pdfPath = join(dir, 'src.pdf');
    if (kind === 'pdf') {
      await writeFile(pdfPath, bytes);
    } else {
      const pptxPath = join(dir, 'src.pptx');
      await writeFile(pptxPath, bytes);
      // LibreOffice headless needs a writable profile; point HOME at the scratch dir so it never
      // touches the container home and parallel conversions don't collide.
      await exec(
        'soffice',
        ['--headless', '--nologo', '--nofirststartwizard', '--convert-to', 'pdf', '--outdir', dir, pptxPath],
        { timeout: SOFFICE_TIMEOUT_MS, env: { ...process.env, HOME: dir }, maxBuffer: BIG_BUFFER },
      );
      pdfPath = join(dir, 'src.pdf'); // soffice names output after the input stem
    }
    // pdftoppm → page-1.png, page-2.png, …
    await exec('pdftoppm', ['-png', '-r', String(RENDER_DPI), pdfPath, join(dir, 'page')], {
      timeout: PDFTOPPM_TIMEOUT_MS,
      maxBuffer: BIG_BUFFER,
    });
    const files = (await readdir(dir)).filter((f) => /^page-?\d+\.png$/.test(f)).sort(byPageNum);
    if (files.length === 0) throw new Error('rasterize produced no pages');
    if (files.length > MAX_PAGES) throw new Error(`too many pages (${files.length} > ${MAX_PAGES})`);
    const pages: { index: number; png: Buffer }[] = [];
    for (let i = 0; i < files.length; i++) {
      pages.push({ index: i + 1, png: await readFile(join(dir, files[i]!)) });
    }
    return { pageCount: pages.length, pages };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function byPageNum(a: string, b: string): number {
  const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
  const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
  return na - nb;
}

/** Minimal PNG dimension reader (IHDR). Throws if the buffer is not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Small bounded cache of rotated text tiles, keyed by watermark text. The tile is identity-stable
// per student (name + short id, no timestamp), so all of a student's page views reuse one tile and
// each page view costs a single composite subprocess instead of two.
const tileCache = new Map<string, Buffer>();
const TILE_CACHE_MAX = 200;

async function tileFor(text: string): Promise<Buffer> {
  const key = createHash('sha256').update(text).digest('hex');
  const hit = tileCache.get(key);
  if (hit) return hit;
  const dir = await mkdtemp(join(tmpdir(), 'wmtile-'));
  try {
    const tileP = join(dir, 'tile.png');
    await exec(
      'convert',
      ['-background', 'none', '-fill', 'rgba(60,60,60,0.22)', '-font', FONT, '-pointsize', '26',
        `label:${text}`, '-bordercolor', 'none', '-border', '46x32', '-rotate', '-30', tileP],
      { timeout: CONVERT_TIMEOUT_MS, maxBuffer: BIG_BUFFER },
    );
    const tile = await readFile(tileP);
    if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value as string);
    tileCache.set(key, tile);
    return tile;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ImageMagick args that composite the translucent tiled watermark over the base page.
// Build the watermark layer as a TRANSPARENT tiled canvas, then composite it over the page.
// NOTE: `-size WxH tile:<file>` flattens the transparent tile onto an OPAQUE (black) canvas,
// which blacked out the whole page. The correct idiom is a transparent canvas (xc:none)
// painted with the tile as the fill pattern via `-tile … -draw rectangle`, which preserves
// per-pixel alpha so only the translucent text lands on the page.
// ImageMagick args that downscale the base to the target size, then composite the translucent
// tiled watermark over it. Downscaling the stored 150-DPI base at request time (tw/th ≤ source)
// cuts both the composite cost and the output size — so EXISTING materials get smaller/faster
// without re-rendering. The watermark canvas is sized to the SAME target dims so it lands exactly.
// NOTE: `-size WxH tile:<file>` flattens the transparent tile onto an OPAQUE (black) canvas, which
// blacked out the whole page; the correct idiom is a transparent canvas (xc:none) painted with the
// tile as the fill pattern via `-tile … -draw rectangle`, which preserves per-pixel alpha.
function compositeArgs(baseP: string, tileP: string, tw: number, th: number): string[] {
  return [baseP, '-resize', `${tw}x${th}`,
    '(', '-size', `${tw}x${th}`, 'xc:none', '-tile', tileP, '-draw', `rectangle 0,0 ${tw},${th}`, ')',
    '-compose', 'over', '-composite'];
}

/** Composite the identity watermark over a base page PNG and encode the result. Optionally
 *  downscales to `maxWidth` (preserving aspect, never upscaling). Prefers WebP (far smaller than
 *  PNG → much faster transfer); falls back to PNG if the ImageMagick webp delegate is unavailable,
 *  so a page always renders. Returns the bytes and their mime type. */
export async function renderWatermarkedPage(
  basePng: Buffer, text: string, opts?: { webp?: boolean; quality?: number; maxWidth?: number },
): Promise<{ bytes: Buffer; contentType: string }> {
  const safe = (text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || 'Concept Mastery';
  const tile = await tileFor(safe);
  const { width, height } = pngSize(basePng);
  const maxW = opts?.maxWidth ?? 0;
  let tw = width, th = height;
  if (maxW > 0 && width > maxW) { const s = maxW / width; tw = Math.round(width * s); th = Math.round(height * s); }
  const wantWebp = opts?.webp !== false;
  const quality = String(opts?.quality ?? 82);
  const dir = await mkdtemp(join(tmpdir(), 'wm-'));
  try {
    const baseP = join(dir, 'base.png');
    const tileP = join(dir, 'tile.png');
    await writeFile(baseP, basePng);
    await writeFile(tileP, tile);
    const args = compositeArgs(baseP, tileP, tw, th);
    if (wantWebp) {
      const outW = join(dir, 'out.webp');
      try {
        await exec('convert', [...args, '-quality', quality, outW], { timeout: CONVERT_TIMEOUT_MS, maxBuffer: BIG_BUFFER });
        const b = await readFile(outW);
        if (b.length > 0) return { bytes: b, contentType: 'image/webp' };
      } catch { /* webp delegate missing → fall through to PNG */ }
    }
    const outP = join(dir, 'out.png');
    await exec('convert', [...args, outP], { timeout: CONVERT_TIMEOUT_MS, maxBuffer: BIG_BUFFER });
    return { bytes: await readFile(outP), contentType: 'image/png' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Back-compat PNG-only watermark (returns bytes). */
export async function watermarkPng(basePng: Buffer, text: string): Promise<Buffer> {
  return (await renderWatermarkedPage(basePng, text, { webp: false })).bytes;
}
