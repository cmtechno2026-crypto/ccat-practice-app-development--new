// TeacherHub training module .txt format (v2). Content (title, minutes, description, lesson body) lives
// in a .txt the admin fills and uploads; the icon is a UI picker (not in the file). Questions are
// optional and carry NO marker. All-or-nothing parse with pinpointed Block/line errors.
//
//   >> TITLE: Welcome to Concept Mastery      # required
//   >> MINUTES: 5                             # optional
//   >> QUESTIONS: 10                          # optional, per-module question count (default 10)
//   >> DESCRIPTION: One line shown on the card # optional
//   >> BODY:                                  # optional; every line after, until a Q: line, is HTML
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
  body_html: string | null; quiz: QuizQuestion[]; questions_per_module: number; active: boolean;
}
export interface ParseResult { ok: boolean; modules: ParsedModule[]; errors: string[] }

export const DEFAULT_QPM = 10;
const MARKER = /^>>\s*([A-Za-z]+):[ \t]?(.*)$/;
const OPTION = /^([A-Za-z])[).][ \t]?(.*)$/;
const ANSWER = /^Answer:[ \t]?(.*)$/i;

export const TXT_TEMPLATE = `# TeacherHub module template — fill the lines below.
# Lines starting with # are comments (ignored). Keep the >> markers.

>> TITLE: Welcome to Concept Mastery
>> MINUTES: 5
>> QUESTIONS: ${DEFAULT_QPM}
>> DESCRIPTION: An introduction to our values, mission and role.

>> BODY:
<h2>Welcome, Teacher!</h2>
<p>Your lesson HTML goes here…</p>

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
    `>> MINUTES: ${m.duration_mins ?? 0}`,
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
    let qpm: number = DEFAULT_QPM;
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
      else { const idx = labels.indexOf(q.answer); if (idx < 0) err(q.n, `Answer: ${q.answer} does not match any option`); else quiz.push({ q: q.q, opts: q.opts.map(o => o.text), answer: idx }); }
      q = null;
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
      if (state === 'body') {
        if (/^Q:/i.test(trimmed)) { state = 'quiz'; q = { n, q: trimmed.slice(2).trim(), opts: [], answer: null }; continue; }
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
        else err(n, `unknown marker ">> ${mm[1]}:"`);
        continue;
      }
      if (/^Q:/i.test(trimmed)) { state = 'quiz'; q = { n, q: trimmed.slice(2).trim(), opts: [], answer: null }; continue; }
      err(n, `unexpected line (expected ">> TITLE:" etc, or "Q:"): "${text.slice(0, 40)}"`);
    }
    flushQuestion();

    if (!title) err(block.lines[0]?.n ?? 0, 'missing >> TITLE');
    if (title) modules.push({ title, duration_mins: duration, description, body_html: bodyLines.join('\n').trim() || null, quiz, questions_per_module: qpm, active: true });
  }

  if (blockNo === 0) errors.push('No modules found. Each module needs ">> TITLE:"; separate modules with a line of ---.');
  if (errors.length) return { ok: false, modules: [], errors };
  return { ok: true, modules, errors: [] };
}
