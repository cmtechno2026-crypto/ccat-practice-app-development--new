// Manual question import — CSV / paste parser (manual bulk authoring). Everything is
// admin-entered; nothing is generated. The parsed rows are previewed and fixed before saving.
//
// Columns (header required, case-insensitive, order-flexible):
//   stem, type, option_a, option_b, option_c, option_d, option_e, option_f, correct, explanation
// - `correct` is the LETTER of the correct option (A–F), or its 1-based number. Single correct answer.
// - option_e/option_f are optional. Empty option cells are ignored.
// - `type` defaults to 'verbal_analogy' when blank.

export type ImportRow = {
  stem: string;
  type: string;
  options: string[];      // non-empty option texts, in order
  correctIndex: number;   // index into `options`, or -1 if unresolved
  explanation: string;
  issues: string[];       // human-readable problems; empty = ready to import
};

export const CSV_TEMPLATE =
  'stem,type,option_a,option_b,option_c,option_d,correct,explanation\n' +
  '"Cat is to Kitten as Dog is to?",verbal_analogy,Puppy,Cub,Foal,Calf,A,"A young dog is a puppy."\n' +
  '"Which number comes next: 2, 4, 8, 16, ?",number_series,32,24,20,18,A,"Each term doubles."\n' +
  '"Odd one out",non_verbal,Circle,Square,Triangle,Dog,D,"Dog is not a shape."\n';

// Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas, and "" escaped quotes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '', row: string[] = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\n') pushRow();
    else if (c === '\r') { /* ignore */ }
    else field += c;
  }
  if (field.length || row.length) pushRow();
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

function letterToIndex(v: string, optionCount: number): number {
  const t = v.trim().toUpperCase();
  if (!t) return -1;
  if (/^[A-F]$/.test(t)) return 'ABCDEF'.indexOf(t);
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= optionCount) return n - 1;
  return -1;
}

export function parseQuestionsCsv(text: string): { rows: ImportRow[]; error?: string } {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], error: 'Nothing to import — paste rows or choose a file.' };
  const header = table[0].map(h => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iStem = col('stem');
  if (iStem < 0) return { rows: [], error: 'Missing a "stem" column. Download the template to see the expected columns.' };
  const iType = col('type'), iCorrect = col('correct'), iExpl = col('explanation');
  const optCols = ['option_a', 'option_b', 'option_c', 'option_d', 'option_e', 'option_f'].map(col).filter(i => i >= 0);
  if (optCols.length < 2) return { rows: [], error: 'Need at least option_a and option_b columns.' };

  const rows: ImportRow[] = [];
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i].trim() : '');
    const stem = get(iStem);
    const options = optCols.map(get).filter(x => x !== '');
    const type = get(iType) || 'verbal_analogy';
    const explanation = get(iExpl);
    const correctIndex = letterToIndex(get(iCorrect), options.length);
    const issues: string[] = [];
    if (!stem) issues.push('missing stem');
    if (options.length < 2) issues.push('needs ≥2 options');
    if (correctIndex < 0) issues.push('correct must be a letter A–' + 'ABCDEF'[Math.max(1, options.length) - 1] + ' of a filled option');
    rows.push({ stem, type, options, correctIndex, explanation, issues });
  }
  return { rows };
}

// Convert a ready row into the option/prompt block payload the batch-author endpoint expects.
export function rowToCard(row: ImportRow) {
  const ids = 'abcdef';
  return {
    stem: row.stem,
    type: row.type || 'verbal_analogy',
    explanation: row.explanation,
    active: true,
    img: null as null,
    opts: row.options.map((text, i) => ({ option_id: ids[i], text, correct: i === row.correctIndex })),
  };
}

// ---- Scoped bulk import (each row carries its own scope) -----------------------------------------
// Columns: grade, battery, category, difficulty, stem, type, option_a..f, correct, explanation.
//   grade      = grade number (e.g. 5)
//   battery    = Verbal / Quantitative / Non-verbal (the reasoning section)
//   category   = the subcategory/topic under that battery (from the live taxonomy)
//   difficulty = Easy / Medium / Hard
// The server resolves battery/category/difficulty/grade by NAME and rejects rows it can't place. The
// client only checks that scope cells are non-empty + the question is structurally valid.
export type ScopedImportRow = {
  grade: string; battery: string; category: string; difficulty: string;
  stem: string; type: string; options: string[]; correctIndex: number; explanation: string;
  issues: string[];
};

export const SCOPED_CSV_TEMPLATE =
  'grade,battery,category,difficulty,stem,type,option_a,option_b,option_c,option_d,correct,explanation\n' +
  '5,Non-verbal,Figure classification,Medium,"Which figure is the odd one out?",non_verbal,Square,Circle,Triangle,Dog,D,"Dog is not a shape."\n' +
  '5,Quantitative,Number Series,Easy,"2, 4, 8, 16, ?",number_series,32,24,20,18,A,"Each term doubles."\n' +
  '5,Verbal,Verbal analogy,Hard,"Cat is to Kitten as Dog is to?",verbal_analogy,Puppy,Cub,Foal,Calf,A,"A young dog is a puppy."\n';

export function parseScopedQuestionsCsv(text: string): { rows: ScopedImportRow[]; error?: string } {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], error: 'Nothing to import — paste rows or choose a file.' };
  const header = table[0].map(h => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iStem = col('stem');
  const iGrade = col('grade'), iBattery = col('battery'), iCategory = col('category'), iDifficulty = col('difficulty');
  const missingScope = [['grade', iGrade], ['battery', iBattery], ['category', iCategory], ['difficulty', iDifficulty]].filter(([, i]) => (i as number) < 0).map(([n]) => n);
  if (iStem < 0 || missingScope.length) {
    return { rows: [], error: `Missing column(s): ${[iStem < 0 ? 'stem' : null, ...missingScope].filter(Boolean).join(', ')}. Download the template to see the expected columns.` };
  }
  const iType = col('type'), iCorrect = col('correct'), iExpl = col('explanation');
  const optCols = ['option_a', 'option_b', 'option_c', 'option_d', 'option_e', 'option_f'].map(col).filter(i => i >= 0);
  if (optCols.length < 2) return { rows: [], error: 'Need at least option_a and option_b columns.' };

  const rows: ScopedImportRow[] = [];
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i].trim() : '');
    const grade = get(iGrade), battery = get(iBattery), category = get(iCategory), difficulty = get(iDifficulty);
    const stem = get(iStem);
    const options = optCols.map(get).filter(x => x !== '');
    const type = get(iType);
    const explanation = get(iExpl);
    const correctIndex = letterToIndex(get(iCorrect), options.length);
    const issues: string[] = [];
    if (!grade) issues.push('missing grade');
    if (!battery) issues.push('missing battery');
    if (!category) issues.push('missing category');
    if (!difficulty) issues.push('missing difficulty');
    if (!stem) issues.push('missing stem');
    if (options.length < 2) issues.push('needs ≥2 options');
    if (correctIndex < 0) issues.push('correct must be a letter A–' + 'ABCDEF'[Math.max(1, options.length) - 1] + ' of a filled option');
    rows.push({ grade, battery, category, difficulty, stem, type, options, correctIndex, explanation, issues });
  }
  return { rows };
}

// Convert a ready scoped row into the /v1/admin/content/import payload row (scope by name; the server
// resolves names -> ids and rejects anything it can't place).
export function scopedRowToImport(row: ScopedImportRow) {
  return {
    grade: row.grade,
    battery: row.battery,
    category: row.category,
    difficulty: row.difficulty,
    stem: row.stem,
    question_type: row.type || undefined,
    explanation: row.explanation || undefined,
    options: row.options.map((text, i) => ({ text, correct: i === row.correctIndex })),
  };
}
