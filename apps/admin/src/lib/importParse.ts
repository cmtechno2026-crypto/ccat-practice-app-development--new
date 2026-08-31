// Deterministic parser for the set editor's "Bulk add from file" importer. This is the ONE universal
// question format for every subcategory and set — it carries NO taxonomy (type / subcategory / category
// / grade / difficulty come from the SET being edited). It parses the block format below out of plain
// text (.md / .txt, or a .csv that actually contains this text) and produces the editable card objects
// the editor appends, so imported questions flow through the existing Save-draft / Publish path. Nothing
// is generated or scored — strict, deterministic parsing. All-or-nothing: any deviation rejects the
// whole file with block/line-numbered errors.
//
// FORMAT:
//   #  …                         comment line — ignored anywhere in the file
//   Q: <question text>           begins a block; text may span several lines until the first option
//   A) <option text>             options labelled A) B) C) … (a dot works: "A."); 2–6 options
//   B) <option text>
//   Answer: <letter>             the single correct option letter; must match a present option
//   Explanation: <text>          optional; one line
// Blocks are separated by blank line(s); additionally, a new "Q:" line always starts a new block, so the
// format works whether or not the author leaves blank lines between questions.

export type ImportCard = {
  stem: string;
  type: string;              // left '' here; the editor stamps the set's subcategory default
  explanation: string;
  active: boolean;
  img: null;
  opts: { option_id: string; text: string; correct: boolean }[];
};
export type ImportError = { block: number; line: number; message: string; display: string };
export type ImportResult =
  | { ok: true; cards: ImportCard[] }
  | { ok: false; errors: ImportError[] };

const OPTION_IDS = 'abcdef';
const RE_COMMENT = /^\s*#/;
const RE_Q = /^\s*Q:\s*(.*)$/i;
const RE_OPTION = /^\s*([A-Za-z])[).]\s*(.+?)\s*$/;
const RE_ANSWER = /^\s*Answer:\s*([A-Za-z])\s*$/i;
const RE_EXPL = /^\s*Explanation:\s*(.*)$/i;

type Block = {
  n: number; startLine: number;
  stemParts: string[]; qLine: number;
  options: { label: string; text: string; line: number }[];
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
    const mOpt = line.match(RE_OPTION);
    if (mOpt) {
      const label = mOpt[1].toUpperCase();
      if (cur.options.some(o => o.label === label)) cur.dupLabels.push(label);
      cur.options.push({ label, text: mOpt[2].trim(), line: lineNo });
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
    if (!stem) err(b.n, b.qLine, 'no question text after "Q:"');
    if (b.options.length < 2) err(b.n, b.startLine, `only ${b.options.length} option${b.options.length === 1 ? '' : 's'} found; need at least 2`);
    if (b.options.length > 6) err(b.n, b.startLine, `${b.options.length} options found; a question may have at most 6`);
    for (const dl of dedupe(b.dupLabels)) err(b.n, b.startLine, `duplicate option label "${dl})"`);
    if (b.dupAnswer) err(b.n, b.dupAnswer, 'more than one "Answer:" line');
    if (!b.answer) err(b.n, b.startLine, 'no "Answer:" line');
    else if (!b.options.some(o => o.label === b.answer!.letter))
      err(b.n, b.answer.line, `Answer "${b.answer.letter}" does not match any option (${present} present)`);
    for (const s of b.stray) err(b.n, s.line, `unexpected line "${trunc(s.text)}" (expected an option, "Answer:", "Explanation:", or a blank line)`);

    if (b.options.length >= 2 && b.options.length <= 6 && b.answer && stem && b.options.some(o => o.label === b.answer!.letter)) {
      cards.push({
        stem, type: '', explanation: b.explanation, active: true, img: null,
        opts: b.options.map((o, i) => ({ option_id: OPTION_IDS[i], text: o.text, correct: o.label === b.answer!.letter })),
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, cards };
}

function trunc(s: string, n = 48): string { const t = s.trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
function dedupe(a: string[]): string[] { return [...new Set(a)]; }
