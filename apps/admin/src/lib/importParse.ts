// Deterministic parser for the "Bulk add from file" / "Bulk add sets" importer. This is the ONE universal
// question format for every subcategory and set — it carries NO taxonomy (type / subcategory / category
// / grade / difficulty come from the SET being edited). It parses the block format below out of plain
// text (.md / .txt) and produces the editable card objects the editor appends, so imported questions flow
// through the existing Save-draft / Publish path. Nothing is generated or scored — strict, deterministic
// parsing. All-or-nothing: any deviation rejects the whole file with block/line-numbered errors.
//
// FORMAT (all image lines are OPTIONAL — a text-only file parses exactly as before):
//   #  …                         comment line — ignored anywhere in the file
//   Q: <question text>           begins a block; text optional when a Q-Image is given (figure-only Q)
//   Q-Image: <filename>          optional: the question figure's filename (must exist in the uploaded ZIP)
//   A) <option text>             options labelled A) B) C) … (a dot works: "A."); 2–6 options
//   A-Image: <filename>          optional: option A's image filename (option may be image-only)
//   B) …
//   Answer: <letter>             the single correct option letter; must match a present option
//   Explanation: <text>          optional; one line
// Blocks are separated by blank line(s); a new "Q:" line always starts a new block. Image FILENAMES are
// resolved against a ZIP uploaded alongside the text (see lib/bulkFile.ts); the parser only records the
// referenced names — it never loads image bytes.

export type ImgRef = { asset_id: string; url: string; alt?: string };
export type ImportOpt = {
  option_id: string; text: string; correct: boolean;
  imageRef?: string | null;   // referenced filename from an "<X>-Image:" line (resolved later)
  img?: ImgRef | null;        // resolved asset (filled by the importer after upload)
};
export type ImportCard = {
  stem: string;
  type: string;              // left '' here; the editor stamps the set's subcategory default
  explanation: string;
  active: boolean;
  img: ImgRef | null;        // resolved question figure (filled by the importer after upload)
  qImageRef?: string | null; // referenced filename from a "Q-Image:" line (resolved later)
  opts: ImportOpt[];
};
export type ImportError = { block: number; line: number; message: string; display: string };
export type ImportResult =
  | { ok: true; cards: ImportCard[] }
  | { ok: false; errors: ImportError[] };

const OPTION_IDS = 'abcdef';
const RE_COMMENT = /^\s*#/;
const RE_Q = /^\s*Q:\s*(.*)$/i;
const RE_QIMAGE = /^\s*Q-Image:\s*(.+?)\s*$/i;
const RE_OPTIMAGE = /^\s*([A-Za-z])-Image:\s*(.+?)\s*$/i;
const RE_OPTION = /^\s*([A-Za-z])[).]\s*(.+?)\s*$/;
const RE_ANSWER = /^\s*Answer:\s*([A-Za-z])\s*$/i;
const RE_EXPL = /^\s*Explanation:\s*(.*)$/i;

type Opt = { label: string; text: string; image?: string; line: number };
type Block = {
  n: number; startLine: number;
  stemParts: string[]; qLine: number;
  qImage?: string; dupQImage?: number | null;
  options: Opt[];
  answer: { letter: string; line: number } | null;
  explanation: string;
  phase: 'stem' | 'options';
  stray: { line: number; text: string }[];
  dupAnswer: number | null;
  dupLabels: string[];
};

export function parseImportText(raw: string): ImportResult {
  const text = (raw ?? '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  const lines = text.split('\n');
  const errors: ImportError[] = [];
  // Block-scoped errors read "Block N: …"; pre-block errors read "Line N: …"; global errors read plain.
  const err = (block: number, line: number, message: string) =>
    errors.push({ block, line, message, display: block ? `Block ${block}: ${message}` : line ? `Line ${line}: ${message}` : message });

  const blocks: Block[] = [];
  let cur: Block | null = null;
  const finalize = () => { if (cur) blocks.push(cur); cur = null; };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    if (RE_COMMENT.test(line)) continue;      // comment
    const isBlank = line.trim() === '';

    const mQ = line.match(RE_Q);
    if (mQ) {
      finalize();
      cur = { n: blocks.length + 1, startLine: lineNo, stemParts: mQ[1].trim() ? [mQ[1].trim()] : [], qLine: lineNo,
        options: [], answer: null, explanation: '', phase: 'stem', stray: [], dupAnswer: null, dupLabels: [] };
      continue;
    }

    if (!cur) {
      // Before the first Q: — allow only blanks/comments; anything else is a format error.
      if (!isBlank) {
        const kind = RE_OPTION.test(line) ? 'options found' : RE_ANSWER.test(line) ? '"Answer:" found' : 'text found';
        err(0, lineNo, `${kind} before any "Q:" line`);
      }
      continue;
    }

    if (isBlank) continue;

    const mAns = line.match(RE_ANSWER);
    if (mAns) { if (cur.answer) cur.dupAnswer = lineNo; else cur.answer = { letter: mAns[1].toUpperCase(), line: lineNo }; cur.phase = 'options'; continue; }
    const mExpl = line.match(RE_EXPL);
    if (mExpl) { cur.explanation = mExpl[1].trim(); cur.phase = 'options'; continue; }
    // Question figure (optional). Does not change phase — a multi-line stem may still follow.
    const mQImg = line.match(RE_QIMAGE);
    if (mQImg) { if (cur.qImage) cur.dupQImage = lineNo; else cur.qImage = mQImg[1].trim(); continue; }
    // Option image (optional) — attaches to (or creates) the option with that letter.
    const mOptImg = line.match(RE_OPTIMAGE);
    if (mOptImg) {
      const label = mOptImg[1].toUpperCase();
      const ex = cur.options.find(o => o.label === label);
      if (ex) { if (ex.image) cur.dupLabels.push(label); ex.image = mOptImg[2].trim(); }
      else cur.options.push({ label, text: '', image: mOptImg[2].trim(), line: lineNo });
      cur.phase = 'options';
      continue;
    }
    const mOpt = line.match(RE_OPTION);
    if (mOpt) {
      const label = mOpt[1].toUpperCase();
      const ex = cur.options.find(o => o.label === label);
      if (ex) { if (ex.text) cur.dupLabels.push(label); ex.text = mOpt[2].trim(); }
      else cur.options.push({ label, text: mOpt[2].trim(), line: lineNo });
      cur.phase = 'options';
      continue;
    }
    // Unmatched line: part of a multi-line stem while still before options; otherwise a stray line.
    if (cur.phase === 'stem') cur.stemParts.push(line.trim());
    else cur.stray.push({ line: lineNo, text: line.trim() });
  }
  finalize();

  if (blocks.length === 0 && errors.length === 0) {
    err(0, 0, 'No questions found. Every question starts with a "Q:" line — download the sample to see the exact format.');
    return { ok: false, errors };
  }

  const cards: ImportCard[] = [];
  for (const b of blocks) {
    const stem = b.stemParts.join(' ').trim();
    const present = b.options.length > 1
      ? `${b.options[0].label}–${b.options[b.options.length - 1].label}`
      : b.options.length === 1 ? b.options[0].label : 'none';
    // A question needs text OR a figure.
    if (!stem && !b.qImage) err(b.n, b.qLine, 'question has no text and no "Q-Image:" (add "Q:" text or a "Q-Image:" line)');
    if (b.dupQImage) err(b.n, b.dupQImage, 'more than one "Q-Image:" line');
    if (b.options.length < 2) err(b.n, b.startLine, `only ${b.options.length} option${b.options.length === 1 ? '' : 's'} found; need at least 2`);
    if (b.options.length > 6) err(b.n, b.startLine, `${b.options.length} options found; a question may have at most 6`);
    for (const dl of dedupe(b.dupLabels)) err(b.n, b.startLine, `duplicate option label "${dl})"`);
    if (b.dupAnswer) err(b.n, b.dupAnswer, 'more than one "Answer:" line');
    if (!b.answer) err(b.n, b.startLine, 'no "Answer:" line');
    else if (!b.options.some(o => o.label === b.answer!.letter))
      err(b.n, b.answer.line, `Answer "${b.answer.letter}" does not match any option (${present} present)`);
    for (const s of b.stray) err(b.n, s.line, `unexpected line "${trunc(s.text)}" (expected an option, "Answer:", "Explanation:", "Q-Image:", "<X>-Image:", or a blank line)`);

    if (b.options.length >= 2 && b.options.length <= 6 && b.answer && (stem || b.qImage) && b.options.some(o => o.label === b.answer!.letter)) {
      cards.push({
        stem, type: '', explanation: b.explanation, active: true, img: null,
        qImageRef: b.qImage ?? null,
        opts: b.options.map((o, i) => ({ option_id: OPTION_IDS[i], text: o.text, correct: o.label === b.answer!.letter, imageRef: o.image ?? null })),
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, cards };
}

// All image filenames referenced by the parsed cards (question + option), de-duplicated, order preserved.
export function referencedImages(cards: ImportCard[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (n?: string | null) => { if (n) { const k = n.trim(); if (k && !seen.has(k.toLowerCase())) { seen.add(k.toLowerCase()); out.push(k); } } };
  for (const c of cards) { add(c.qImageRef); for (const o of c.opts) add(o.imageRef); }
  return out;
}

function trunc(s: string, n = 48): string { const t = s.trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
function dedupe(a: string[]): string[] { return [...new Set(a)]; }
