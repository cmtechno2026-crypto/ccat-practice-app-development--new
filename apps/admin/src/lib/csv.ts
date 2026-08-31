// CSV helpers for the SCOPED bulk-import page (pages/ImportQuestions.tsx), which imports questions with
// their own grade/battery/category/difficulty scope straight to the gateway. The set editor's in-editor
// importer uses the universal BLOCK format instead (see lib/importParse.ts) — there is no CSV parser for
// the editor any more.

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
