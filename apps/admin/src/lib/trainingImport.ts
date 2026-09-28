// TeacherHub training module .txt format (v2). Content (title, minutes, description, lesson body) lives
// in a .txt the admin fills and uploads; the icon is a UI picker (not in the file). Questions are
// optional and carry NO marker. All-or-nothing parse with pinpointed Block/line errors.
//
//   >> TITLE: Welcome to Concept Mastery      # required
//   >> QUESTIONS: 10                          # optional, per-module question count (default 10)
//   >> DESCRIPTION: One line shown on the card # optional
//   >> BODY:                                  # optional; every line after, until a Q: line, is HTML
//   >> SWAP: Section heading (optional)        # a "say this, not that" list
//   Stiff phrasing => Natural phrasing         # one pair per line: left | right  OR  left => right
//   <h2>Welcome, Teacher!</h2>
//   <p>…</p>
//   Q: How soon to review a request?          # optional questions (no >> marker)
//   A) Within 1 week
//   B) Within 24 hours
//   Answer: B
//   ---                                       # separates modules (bulk import)

export interface QuizQuestion { q: string; opts: string[]; answer: number }
export interface ParsedModule {
  title: string; duration_mins: number | null; description: string | null;
  body_html: string | null; quiz: QuizQuestion[]; questions_per_module: number | null; active: boolean;
}
export interface ParseResult { ok: boolean; modules: ParsedModule[]; errors: string[] }

export const DEFAULT_QPM = 10;
const MARKER = /^>>\s*([A-Za-z]+):[ \t]?(.*)$/;
const OPTION = /^([A-Za-z])[).][ \t]?(.*)$/;
const ANSWER = /^Answer:[ \t]?(.*)$/i;

export const TXT_TEMPLATE = `# TeacherHub module template — fill the lines below.
# Lines starting with # are comments (ignored). Keep the >> markers.

>> TITLE: Welcome to Concept Mastery
>> QUESTIONS: ${DEFAULT_QPM}
>> DESCRIPTION: An introduction to our values, mission and role.

>> BODY:
<h2>Welcome, Teacher!</h2>
<p>Your lesson HTML goes here…</p>

# Or, instead of BODY HTML, use a SWAP list — a "say this, not that" table.
# Heading after ">> SWAP:" is optional. One pair per line: left | right (or left => right).
# >> SWAP: Section heading (optional)
# Stiff phrasing => Natural phrasing
# Another stiff line => Its natural version

# Questions are optional and have NO marker. Add them here or in the panel:
# Q: How soon should you review a parent request?
# A) Within 1 week
# B) Within 24 hours
# Answer: B
`;

// Serialize an existing module back to the .txt so an admin can download → edit → re-upload.
export function moduleToTxt(m: { title: string; duration_mins?: number | null; questions_per_module?: number | null; description?: string | null; body_html?: string | null; quiz?: QuizQuestion[] | null }): string {
  const lines = [
    `>> TITLE: ${m.title || ''}`,
    `>> QUESTIONS: ${m.questions_per_module ?? DEFAULT_QPM}`,
    `>> DESCRIPTION: ${m.description || ''}`,
    '', '>> BODY:', (m.body_html || '').trim(), '',
  ];
  for (const q of m.quiz || []) {
    lines.push(`Q: ${q.q}`);
    q.opts.forEach((o, i) => lines.push(`${String.fromCharCode(65 + i)}) ${o}`));
    lines.push(`Answer: ${String.fromCharCode(65 + (q.answer || 0))}`, '');
  }
  return lines.join('\n');
}

const escHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function swapSectionHtml(heading: string | null, rows: [string, string][]): string {
  const head = heading ? `<div style="font-size:20px;font-weight:800;color:#1c3f6e;margin:0 0 6px">${escHtml(heading)}</div>` : '';
  const body = rows.map(([l, r], i) => (
    `<div style="display:flex;align-items:center;gap:16px;padding:16px 2px;border-top:${i === 0 ? 'none' : '1px solid #e6ebf3'}">`
    + `<div style="flex:1 1 0;min-width:0;color:#b23a52;text-decoration:line-through;font-size:15px;line-height:1.4">${escHtml(l)}</div>`
    + `<div style="flex:0 0 auto;width:40px;height:40px;border-radius:999px;background:#e9f1fb;display:flex;align-items:center;justify-content:center;color:#2f6fd0;font-size:18px;font-weight:700">&#8594;</div>`
    + `<div style="flex:1 1 0;min-width:0;color:#1c3f6e;font-weight:800;font-size:15px;line-height:1.4">${escHtml(r)}</div>`
    + `</div>`
  )).join('');
  return `<div class="th-swap" style="margin:.4rem 0">${head}${body}</div>`;
}

export function parseTrainingText(input: string): ParseResult {
  const errors: string[] = [];
  const modules: ParsedModule[] = [];
  const allLines = input.replace(/\r\n?/g, '\n').split('\n');

  const blocks: { lines: { n: number; text: string }[] }[] = [];
  let cur: { n: number; text: string }[] = [];
  allLines.forEach((text, i) => {
    if (/^-{3,}\s*$/.test(text)) { blocks.push({ lines: cur }); cur = []; }
    else cur.push({ n: i + 1, text });
  });
  blocks.push({ lines: cur });

  let blockNo = 0;
  for (const block of blocks) {
    if (!block.lines.some(l => l.text.trim() && !l.text.trim().startsWith('#'))) continue;
    blockNo++;
    const err = (n: number, msg: string) => errors.push(`Block ${blockNo}, line ${n}: ${msg}`);

    let title: string | null = null, description: string | null = null, duration: number | null = null;
    let qpm: number | null = null;
    const bodyLines: string[] = [];
    const quiz: QuizQuestion[] = [];
    let state: 'head' | 'body' | 'quiz' | 'swap' = 'head';
    let swapHeading: string | null = null;
    let swapRows: [string, string][] = [];
    let q: { n: number; q: string; opts: { label: string; text: string }[]; answer: string | null } | null = null;

    const flushQuestion = () => {
      if (!q) return;
      if (!q.q) err(q.n, 'question has no text (Q:)');
      if (q.opts.length < 2 || q.opts.length > 6) err(q.n, `question needs 2–6 options (has ${q.opts.length})`);
      const labels = q.opts.map(o => o.label);
      if (new Set(labels).size !== labels.length) err(q.n, 'duplicate option labels');
      if (!q.answer) err(q.n, 'missing Answer:');
      else { const idx = labels.indexOf(q.answer); if (idx < 0) err(q.n, `Answer: ${q.answer} does not match any option`); else quiz.push({ q: q.q, opts: q.opts.map(o => o.text), answer: idx }); }
      q = null;
    };

    const flushSwap = () => {
      if (swapRows.length) bodyLines.push(swapSectionHtml(swapHeading, swapRows));
      swapRows = []; swapHeading = null;
    };

    for (const { n, text } of block.lines) {
      const trimmed = text.trim();
      if (state !== 'body' && (trimmed === '' || trimmed.startsWith('#'))) continue;

      if (state === 'quiz') {
        if (/^Q:/i.test(trimmed)) { flushQuestion(); q = { n, q: trimmed.slice(2).trim(), opts: [], answer: null }; continue; }
        const om = OPTION.exec(trimmed);
        if (om) { q!.opts.push({ label: om[1].toUpperCase(), text: (om[2] || '').trim() }); continue; }
        const am = ANSWER.exec(trimmed);
        if (am) { q!.answer = (am[1] || '').trim().toUpperCase().charAt(0) || null; continue; }
        err(n, `unexpected line in questions: "${text.slice(0, 40)}"`);
        continue;
      }
      if (state === 'swap') {
        if (/^Q:/i.test(trimmed)) { flushSwap(); state = 'quiz'; q = { n, q: trimmed.slice(2).trim(), opts: [], answer: null }; continue; }
        const sm = MARKER.exec(trimmed);
        if (sm) {
          const key = sm[1].toLowerCase(); const val = (sm[2] || '').trim();
          if (key === 'swap') { flushSwap(); state = 'swap'; swapHeading = val || null; swapRows = []; continue; }
          if (key === 'body') { flushSwap(); state = 'body'; if (val) bodyLines.push(val); continue; }
          err(n, `">> ${sm[1]}:" is not allowed inside a >> SWAP list`); continue;
        }
        const pm = trimmed.match(/^(.*?)\s*(?:=>|\|)\s*(.*)$/);
        if (pm && (pm[1] || '').trim() && (pm[2] || '').trim()) { swapRows.push([(pm[1] || '').trim(), (pm[2] || '').trim()]); continue; }
        err(n, `SWAP line needs "left | right" or "left => right": "${text.slice(0, 40)}"`);
        continue;
      }
      if (state === 'body') {
        if (/^Q:/i.test(trimmed)) { state = 'quiz'; q = { n, q: trimmed.slice(2).trim(), opts: [], answer: null }; continue; }
        const bm = MARKER.exec(trimmed);
        if (bm && bm[1].toLowerCase() === 'swap') { state = 'swap'; swapHeading = (bm[2] || '').trim() || null; swapRows = []; continue; }
        bodyLines.push(text);
        continue;
      }

      // head
      const mm = MARKER.exec(trimmed);
      if (mm) {
        const key = mm[1].toLowerCase(); const val = (mm[2] || '').trim();
        if (key === 'title') { if (title !== null) err(n, 'duplicate >> TITLE'); title = val; }
        else if (key === 'minutes') { const d = Number(val); if (val && (!Number.isInteger(d) || d < 0 || d > 600)) err(n, 'MINUTES must be an integer 0–600'); else if (val) duration = d; }
        else if (key === 'questions') { const d = Number(val); if (val && (!Number.isInteger(d) || d < 0 || d > 50)) err(n, 'QUESTIONS must be an integer 0–50'); else if (val) qpm = d; }
        else if (key === 'description') description = val || null;
        else if (key === 'body') { state = 'body'; if (val) bodyLines.push(val); }
        else if (key === 'swap') { state = 'swap'; swapHeading = val || null; swapRows = []; }
        else err(n, `unknown marker ">> ${mm[1]}:"`);
        continue;
      }
      if (/^Q:/i.test(trimmed)) { state = 'quiz'; q = { n, q: trimmed.slice(2).trim(), opts: [], answer: null }; continue; }
      err(n, `unexpected line (expected ">> TITLE:" etc, or "Q:"): "${text.slice(0, 40)}"`);
    }
    flushSwap();
    flushQuestion();

    if (!title) err(block.lines[0]?.n ?? 0, 'missing >> TITLE');
    if (title) modules.push({ title, duration_mins: duration, description, body_html: bodyLines.join('\n').trim() || null, quiz, questions_per_module: qpm, active: true });
  }

  if (blockNo === 0) errors.push('No modules found. Each module needs ">> TITLE:"; separate modules with a line of ---.');
  if (errors.length) return { ok: false, modules: [], errors };
  return { ok: true, modules, errors: [] };
}
