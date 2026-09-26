// Universal .txt bulk-import parser for TeacherHub training modules.
// Mirrors the CCAT question importer: one deterministic parser, all-or-nothing — any malformed block
// rejects the WHOLE file with pinpointed "Block N / Line N" errors; nothing is created or guessed.
//
// Block format (blocks separated by a line of exactly ---):
//
//   Title: Welcome & Onboarding        # required, once
//   Icon: 🎓                           # optional emoji
//   Duration: 8                        # optional integer minutes
//   Description: Get started…          # optional one line
//   Body:                              # optional; everything after, until the first Q:, is body HTML
//   <h4>Welcome</h4>
//   <p>…</p>
//   Q: How soon to review a request?   # optional quiz; repeat Q blocks
//   A) Within 1 week                   # 2–6 options, labelled A) B) C)… (A. also works)
//   B) Within 24 hours
//   Answer: B                          # exactly one correct option letter, must match a present option
//
// # any line starting with # is a comment (ignored), except inside the Body block.

export interface QuizQuestion { q: string; opts: string[]; answer: number }
export interface ParsedModule {
  title: string; icon: string | null; duration_mins: number | null;
  description: string | null; body_html: string | null; quiz: QuizQuestion[]; active: boolean;
}
export interface ParseResult { ok: boolean; modules: ParsedModule[]; errors: string[] }

const FIELD = /^([A-Za-z-]+):[ \t]?(.*)$/;
const OPTION = /^([A-Za-z])[).][ \t]?(.*)$/;

export function parseTrainingText(input: string): ParseResult {
  const errors: string[] = [];
  const modules: ParsedModule[] = [];
  const allLines = input.replace(/\r\n?/g, '\n').split('\n');

  // Split into blocks on a line of only dashes, remembering each line's real (1-based) number.
  const blocks: { lines: { n: number; text: string }[] }[] = [];
  let cur: { n: number; text: string }[] = [];
  allLines.forEach((text, i) => {
    if (/^-{3,}\s*$/.test(text)) { blocks.push({ lines: cur }); cur = []; }
    else cur.push({ n: i + 1, text });
  });
  blocks.push({ lines: cur });

  let blockNo = 0;
  for (const block of blocks) {
    // Skip a block that is entirely blank/comments (e.g. trailing separator).
    if (!block.lines.some(l => l.text.trim() && !l.text.trim().startsWith('#'))) continue;
    blockNo++;
    const err = (n: number, msg: string) => errors.push(`Block ${blockNo}, line ${n}: ${msg}`);

    let title: string | null = null, icon: string | null = null, description: string | null = null;
    let duration: number | null = null;
    const bodyLines: string[] = [];
    const quiz: QuizQuestion[] = [];
    let state: 'head' | 'body' | 'quiz' = 'head';
    let q: { n: number; q: string; opts: { label: string; text: string }[]; answer: string | null } | null = null;

    const flushQuestion = () => {
      if (!q) return;
      if (!q.q) err(q.n, 'question has no text (Q:)');
      if (q.opts.length < 2 || q.opts.length > 6) err(q.n, `question needs 2–6 options (has ${q.opts.length})`);
      const labels = q.opts.map(o => o.label);
      if (new Set(labels).size !== labels.length) err(q.n, 'duplicate option labels');
      if (!q.answer) err(q.n, 'missing Answer:');
      else {
        const idx = labels.indexOf(q.answer);
        if (idx < 0) err(q.n, `Answer: ${q.answer} does not match any option`);
        else quiz.push({ q: q.q, opts: q.opts.map(o => o.text), answer: idx });
      }
      q = null;
    };

    for (const { n, text } of block.lines) {
      const trimmed = text.trim();
      if (state !== 'body' && (trimmed === '' || trimmed.startsWith('#'))) continue;

      if (state === 'quiz') {
        if (/^Q:/i.test(trimmed)) { flushQuestion(); q = { n, q: trimmed.slice(2).trim(), opts: [], answer: null }; continue; }
        const om = OPTION.exec(trimmed);
        if (om) { q!.opts.push({ label: om[1].toUpperCase(), text: (om[2] || '').trim() }); continue; }
        const fm = FIELD.exec(trimmed);
        if (fm && /^answer$/i.test(fm[1])) { q!.answer = (fm[2] || '').trim().toUpperCase().charAt(0) || null; continue; }
        err(n, `unexpected line in quiz: "${text.slice(0, 40)}"`);
        continue;
      }

      if (state === 'body') {
        if (/^Q:/i.test(trimmed)) { state = 'quiz'; q = { n, q: trimmed.slice(2).trim(), opts: [], answer: null }; continue; }
        bodyLines.push(text);
        continue;
      }

      // state === 'head'
      const fm = FIELD.exec(text);
      if (!fm) { err(n, `unexpected line (expected Title:/Icon:/Duration:/Description:/Body:/Q:): "${text.slice(0, 40)}"`); continue; }
      const key = fm[1].toLowerCase(); const val = (fm[2] || '').trim();
      if (key === 'title') { if (title !== null) err(n, 'duplicate Title:'); title = val; }
      else if (key === 'icon') icon = val || null;
      else if (key === 'duration') { const d = Number(val); if (!Number.isInteger(d) || d < 0 || d > 600) err(n, 'Duration must be an integer 0–600'); else duration = d; }
      else if (key === 'description') description = val || null;
      else if (key === 'body') { state = 'body'; if (val) bodyLines.push(val); }
      else if (key === 'q') { state = 'quiz'; q = { n, q: val, opts: [], answer: null }; }
      else err(n, `unknown field "${fm[1]}:"`);
    }
    flushQuestion();

    if (!title) err(block.lines[0]?.n ?? 0, 'missing Title:');
    if (title) {
      modules.push({
        title, icon, duration_mins: duration, description,
        body_html: bodyLines.join('\n').trim() || null, quiz, active: true,
      });
    }
  }

  if (blockNo === 0) errors.push('No modules found. Each module starts with "Title:" and blocks are separated by a line of ---.');
  if (errors.length) return { ok: false, modules: [], errors };
  return { ok: true, modules, errors: [] };
}
