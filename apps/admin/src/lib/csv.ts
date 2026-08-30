// Manual question import — CSV / paste parser for the set editor's "Bulk add from CSV". Everything is
// admin-entered; nothing is generated. STRICT, all-or-nothing: any deviation rejects the whole file
// with row-numbered errors; otherwise every row becomes a fully-filled, editable question card.
//
// Format — ONLY the useful fields. Grade / battery / subcategory / difficulty / type come from the SET
// being edited, NEVER from the file. Header row required, then one row per question:
//   question, option_a, option_b, option_c, option_d[, option_e, option_f], correct, explanation
// - question    — the question text; MAY be empty (e.g. odd-one-out where the options are the question).
// - option_a…f  — the options (2–6 non-empty); compacted to A, B, C… in column order.
// - correct     — the LETTER (A–F) of the correct option; must name a non-empty option column.
// - explanation — optional; shown after answering.

// A ready-to-edit question card — the exact shape the editor appends (see SetEditor `Card`).
export type ImportCard = {
  stem: string; type: string; explanation: string; active: boolean;
  img: null; opts: { option_id: string; text: string; correct: boolean }[];
};
export type CsvError = { row: number; message: string; display: string };
export type CsvResult = { ok: true; cards: ImportCard[] } | { ok: false; errors: CsvError[] };

// The downloadable sample: header + the 3 canonical example rows, in EXACTLY this format.
export const SAMPLE_CSV =
  'question,option_a,option_b,option_c,option_d,correct,explanation\n' +
  '"Which one is the odd one out?",Circle,Square,Triangle,Dog,D,"Dog is not a shape."\n' +
  '"Cat is to Kitten as Dog is to ___",Puppy,Cub,Foal,Calf,A,\n' +
  ',Apple,Banana,Carrot,Rose,D,"Rose is not a fruit or vegetable."\n';

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

const OPTION_COLS = ['option_a', 'option_b', 'option_c', 'option_d', 'option_e', 'option_f'];
const OPTION_IDS = 'abcdef';

// Strict parse → ready-to-edit cards, or the full list of row-numbered errors (all-or-nothing).
export function parseQuestionsCsv(text: string): CsvResult {
  const table = parseCsv(text);
  if (table.length === 0) return { ok: false, errors: [{ row: 0, message: 'The file is empty.', display: 'The file is empty — download the sample CSV to see the format.' }] };
  const header = table[0].map(h => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iQuestion = col('question');
  const iCorrect = col('correct'), iExpl = col('explanation');
  const optColIdx = OPTION_COLS.map(col); // header index per column letter, -1 if absent

  const headErrs: CsvError[] = [];
  const he = (m: string) => headErrs.push({ row: 0, message: m, display: m + ' Download the sample CSV to see the expected header.' });
  if (iQuestion < 0) he('Missing a "question" column.');
  if (optColIdx.filter(i => i >= 0).length < 2) he('Need at least "option_a" and "option_b" columns.');
  if (iCorrect < 0) he('Missing a "correct" column.');
  if (headErrs.length) return { ok: false, errors: headErrs };

  const errors: CsvError[] = [];
  const cards: ImportCard[] = [];
  for (let r = 1; r < table.length; r++) {
    const rowNo = r + 1; // header is row 1; first data row is row 2 (matches how the admin sees the file)
    const cells = table[r];
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i].trim() : '');
    const question = get(iQuestion);
    // Non-empty options with their column letter, in column order (A,B,C…).
    const filled: { letter: string; text: string }[] = [];
    for (let k = 0; k < OPTION_COLS.length; k++) {
      const v = optColIdx[k] >= 0 ? get(optColIdx[k]) : '';
      if (v) filled.push({ letter: 'ABCDEF'[k], text: v });
    }
    const correct = get(iCorrect).toUpperCase();
    const explanation = get(iExpl);
    const rowErr = (m: string) => errors.push({ row: rowNo, message: m, display: `Row ${rowNo}: ${m}` });

    if (filled.length < 2) rowErr(`only ${filled.length} option${filled.length === 1 ? '' : 's'} filled; need at least 2`);
    if (!correct) rowErr(`missing 'correct' value`);
    else if (!/^[A-F]$/.test(correct)) rowErr(`'correct' = ${correct} is not a valid option letter (A–F)`);
    else if (!filled.some(f => f.letter === correct)) rowErr(`'correct' = ${correct} but only options ${filled.map(f => f.letter).join(', ') || 'none'} are filled`);

    if (filled.length >= 2 && /^[A-F]$/.test(correct) && filled.some(f => f.letter === correct)) {
      cards.push({
        stem: question, type: '', explanation, active: true, img: null,
        opts: filled.map((f, i) => ({ option_id: OPTION_IDS[i], text: f.text, correct: f.letter === correct })),
      });
    }
  }

  if (errors.length) return { ok: false, errors };
  if (cards.length === 0) return { ok: false, errors: [{ row: 0, message: 'No question rows found.', display: 'No question rows found — add rows beneath the header, or download the sample CSV.' }] };
  return { ok: true, cards };
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
