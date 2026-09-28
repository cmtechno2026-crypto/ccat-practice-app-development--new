// PPTX → interactive course pipeline (deterministic, no generative AI).
// parse .pptx → slides → analyze → rule engine (interactions) + question engine → Course JSON.
// Runs in the gateway (tsx). Deps: fflate (unzip), fast-xml-parser (OOXML).
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

// ---------- Course JSON shape ----------
export type Section =
  | { type: 'text'; title: string; html: string }
  | { type: 'cards'; title: string; items: { title: string; content: string }[] }
  | { type: 'accordion'; title: string; items: { title: string; content: string }[] }
  | { type: 'steps'; title: string; items: { title: string; content: string }[] }
  | { type: 'tabs'; title: string; tabs: { label: string; content: string }[] }
  | { type: 'table'; title: string; rows: string[][] };

export type Question =
  | { type: 'mcq'; q: string; opts: string[]; answer: number; explain?: string; source?: string }
  | { type: 'truefalse'; q: string; answer: boolean; explain?: string; source?: string }
  | { type: 'ordering'; q: string; items: string[]; answer: number[]; source?: string }
  | { type: 'matching'; q: string; pairs: [string, string][]; source?: string };

export interface CourseJson { version: 1; sections: Section[]; questions: Question[] }
export interface BuildResult {
  title: string;
  description: string;
  course: CourseJson;
  quiz: { q: string; opts: string[]; answer: number }[]; // legacy MCQ/TF subset
  slideCount: number;
  warnings: string[];
}

// ---------- OOXML parsing ----------
interface Para { text: string; kind: 'num' | 'bul' | 'none'; lvl: number }
interface Slide { index: number; title: string; body: Para[]; notes: string; tables: string[][][] }

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: false });
const arr = <T,>(x: T | T[] | undefined | null): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

function runText(p: any): string {
  const runs = arr<any>(p['a:r']).map(r => (typeof r['a:t'] === 'string' ? r['a:t'] : typeof r['a:t'] === 'number' ? String(r['a:t']) : '')).join('');
  if (runs) return runs;
  const fld = p['a:fld']; if (fld && typeof fld['a:t'] === 'string') return fld['a:t'];
  return '';
}
function paraKind(p: any): Para['kind'] {
  const pr = p['a:pPr'] || {};
  if (pr['a:buAutoNum'] !== undefined) return 'num';
  if (pr['a:buNone'] !== undefined) return 'none';
  if (pr['a:buChar'] !== undefined) return 'bul';
  return 'bul';
}
function shapeParas(sp: any): Para[] {
  return arr<any>(sp['p:txBody']?.['a:p'])
    .map(p => ({ text: runText(p).replace(/\s+/g, ' ').trim(), kind: paraKind(p), lvl: Number(p['a:pPr']?.['@_lvl'] || 0) }))
    .filter(x => x.text.length > 0);
}
function extractTables(spTree: any): string[][][] {
  const tables: string[][][] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    const frames = arr<any>(node['p:graphicFrame']);
    for (const f of frames) {
      const tbl = f['a:graphic']?.['a:graphicData']?.['a:tbl'];
      if (tbl) {
        const rows = arr<any>(tbl['a:tr']).map(tr => arr<any>(tr['a:tc']).map(tc => shapeParas(tc['a:txBody'] ? { 'p:txBody': tc['a:txBody'] } : {}).map(p => p.text).join(' ')));
        if (rows.length) tables.push(rows);
      }
    }
  };
  walk(spTree);
  return tables;
}

function parsePptx(buf: Buffer | Uint8Array): { slides: Slide[]; warnings: string[] } {
  const warnings: string[] = [];
  let zip: Record<string, Uint8Array>;
  try { zip = unzipSync(new Uint8Array(buf)); } catch { throw new Error('The file is not a readable .pptx (corrupt or wrong format).'); }
  const read = (p: string) => (zip[p] ? strFromU8(zip[p]) : null);

  const presXml = read('ppt/presentation.xml');
  const relXml = read('ppt/_rels/presentation.xml.rels');
  let order: string[] = [];
  if (presXml && relXml) {
    try {
      const rel = parser.parse(relXml);
      const relMap: Record<string, string> = {};
      for (const r of arr<any>(rel.Relationships?.Relationship)) relMap[r['@_Id']] = r['@_Target'];
      const pres = parser.parse(presXml);
      for (const s of arr<any>(pres['p:presentation']?.['p:sldIdLst']?.['p:sldId'])) {
        const tgt = relMap[s['@_r:id']];
        if (tgt) order.push('ppt/' + tgt.replace(/^\.\.\//, '').replace(/^\//, ''));
      }
    } catch { /* fall through to filename ordering */ }
  }
  if (!order.length) {
    order = Object.keys(zip).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => (Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1])));
  }

  const slides: Slide[] = [];
  order.forEach((path, i) => {
    const xml = read(path); if (!xml) return;
    let doc: any; try { doc = parser.parse(xml); } catch { warnings.push(`Slide ${i + 1} could not be read.`); return; }
    const spTree = doc['p:sld']?.['p:cSld']?.['p:spTree']; if (!spTree) return;
    let title = ''; const body: Para[] = [];
    for (const sp of arr<any>(spTree['p:sp'])) {
      const phType = sp['p:nvSpPr']?.['p:nvPr']?.['p:ph']?.['@_type'];
      const paras = shapeParas(sp);
      if (!paras.length) continue;
      if ((phType === 'title' || phType === 'ctrTitle') && !title) title = paras.map(p => p.text).join(' ');
      else body.push(...paras);
    }
    // notes
    let notes = '';
    const nrels = read(path.replace('slides/', 'slides/_rels/') + '.rels');
    if (nrels) {
      try {
        for (const r of arr<any>(parser.parse(nrels).Relationships?.Relationship)) {
          if (String(r['@_Type']).endsWith('/notesSlide')) {
            const np = 'ppt/' + String(r['@_Target']).replace(/^\.\.\//, '');
            const nxml = read(np);
            if (nxml) {
              const nd = parser.parse(nxml);
              const nsp = arr<any>(nd['p:notes']?.['p:cSld']?.['p:spTree']?.['p:sp']);
              const txt: string[] = [];
              for (const sp of nsp) { const phType = sp['p:nvSpPr']?.['p:nvPr']?.['p:ph']?.['@_type']; if (phType === 'body' || phType === undefined) txt.push(...shapeParas(sp).map(p => p.text)); }
              notes = txt.join(' ').trim();
            }
          }
        }
      } catch { /* notes optional */ }
    }
    slides.push({ index: i + 1, title: title.trim(), body, notes, tables: extractTables(spTree) });
  });
  if (!slides.length) throw new Error('No readable slides found in the presentation.');
  return { slides, warnings };
}

// ---------- Analysis + helpers ----------
const shortItems = (paras: Para[]) => paras.filter(p => p.text.length <= 60 && p.lvl === 0);
const isShort = (s: string) => s.length <= 60;
function titleWord(title: string): string { return (title || 'this topic').replace(/[:.]+$/, '').trim(); }

// ---------- Rule Engine: slide → section ----------
function slideToSection(s: Slide): Section | null {
  if (s.tables.length) {
    const rows = s.tables[0].map(r => r.map(c => c.trim()));
    if (rows.length) return { type: 'table', title: s.title || 'Table', rows };
  }
  const top = s.body.filter(p => p.lvl === 0);
  if (top.length === 0 && !s.title) return null;
  if (s.index === 1 && top.length <= 2) return { type: 'text', title: s.title || 'Introduction', html: '<p>' + top.map(p => escapeHtml(p.text)).join('</p><p>') + '</p>' };
  const numbered = top.filter(p => p.kind === 'num').length >= Math.ceil(top.length / 2);
  const items = top.map((p, i) => {
    // pair a level-0 line with its indented children as content
    const children = s.body.filter(c => c.lvl > 0);
    return { title: p.text.replace(/^\d+[.)]\s*/, ''), content: '' as string, _i: i };
  }).map(x => ({ title: x.title, content: x.content }));

  // sub-bullets → content of the preceding item
  const withContent: { title: string; content: string }[] = [];
  let cur: { title: string; content: string } | null = null;
  for (const p of s.body) {
    if (p.lvl === 0) { cur = { title: p.text.replace(/^\d+[.)]\s*/, ''), content: '' }; withContent.push(cur); }
    else if (cur) { cur.content += (cur.content ? ' ' : '') + p.text; }
  }
  const finalItems = withContent.length ? withContent : items;

  if (numbered || /step|stage|phase|process|order|sequence/i.test(s.title)) {
    return { type: 'steps', title: s.title || 'Steps', items: finalItems };
  }
  const n = finalItems.length;
  if (n >= 1 && n <= 4) return { type: 'cards', title: s.title || 'Key points', items: finalItems };
  if (n >= 5) return { type: 'accordion', title: s.title || 'Details', items: finalItems };
  // single paragraph / prose
  return { type: 'text', title: s.title || '', html: '<p>' + finalItems.map(i => escapeHtml(i.title + (i.content ? ' — ' + i.content : ''))).join('</p><p>') + '</p>' };
}

function escapeHtml(s: string) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }

// ---------- Question Engine (deterministic, source-traceable) ----------
function buildQuestions(slides: Slide[]): Question[] {
  const qs: Question[] = [];
  // global pool of short items for distractors
  const pool = Array.from(new Set(slides.flatMap(s => shortItems(s.body).map(p => p.text.replace(/^\d+[.)]\s*/, ''))))).filter(isShort);
  const pick = (exclude: string[], k: number): string[] => {
    const avail = pool.filter(x => !exclude.includes(x));
    const out: string[] = [];
    for (let i = 0; i < avail.length && out.length < k; i++) out.push(avail[i]); // deterministic order
    return out;
  };

  for (const s of slides) {
    const top = shortItems(s.body).map(p => ({ text: p.text.replace(/^\d+[.)]\s*/, ''), num: p.kind === 'num' }));
    const items = top.map(t => t.text);
    const numbered = top.filter(t => t.num).length >= Math.ceil(top.length / 2) || /step|stage|phase|process|order/i.test(s.title);
    const tw = titleWord(s.title);

    // Ordering + "first step" MCQ for numbered/sequence slides (2–6 items)
    if (numbered && items.length >= 2 && items.length <= 6) {
      qs.push({ type: 'ordering', q: `Put these steps in the correct order.`, items: [...items], answer: items.map((_, i) => i), source: `Slide ${s.index}` });
      const distract = pick(items, 3);
      if (distract.length >= 1) qs.push({ type: 'mcq', q: `What is the first step in ${tw}?`, opts: uniqCap([items[0], ...distract], 4), answer: 0, explain: `${items[0]} comes first.`, source: `Slide ${s.index}` });
    } else if (items.length >= 2 && items.length <= 8) {
      // "which of the following is part of X?" MCQ (correct = a real item; distractors from pool)
      const correct = items[0];
      const distract = pick(items, 3);
      if (distract.length >= 2) qs.push({ type: 'mcq', q: `Which of the following is part of ${tw}?`, opts: uniqCap([correct, ...distract], 4), answer: 0, explain: `${correct} is listed under ${tw}.`, source: `Slide ${s.index}` });
      // true/false from a real item
      qs.push({ type: 'truefalse', q: `“${items[0]}” is part of ${tw}.`, answer: true, explain: `Correct — it is listed on the slide.`, source: `Slide ${s.index}` });
    }

    // matching from a table with 2 columns
    if (s.tables.length) {
      const rows = s.tables[0].filter(r => r.length >= 2 && r[0].trim() && r[1].trim());
      const body = rows.slice(rows.length > 1 && /—|:|=>/.test('') ? 1 : 0); // keep all; header detection is unreliable
      const pairs = rows.filter(r => isShort(r[0]) && r[1].length <= 120).slice(0, 6).map(r => [r[0].trim(), r[1].trim()] as [string, string]);
      if (pairs.length >= 2) qs.push({ type: 'matching', q: `Match each item with its description (${s.title || 'from the table'}).`, pairs, source: `Slide ${s.index}` });
    }

    // definition true/false from notes ("X is Y")
    if (s.notes && /\bis\b|\bmeans\b|\bshould\b/i.test(s.notes) && s.notes.length <= 200) {
      qs.push({ type: 'truefalse', q: s.notes.replace(/\s+/g, ' ').trim(), answer: true, explain: 'Stated in the speaker notes.', source: `Slide ${s.index} (notes)` });
    }
  }
  // de-dup by question text, cap
  const seen = new Set<string>();
  return qs.filter(q => { const k = q.type + '|' + q.q; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 60);
}
function uniqCap(a: string[], k: number): string[] { const out: string[] = []; for (const x of a) if (!out.includes(x) && out.length < k) out.push(x); return out; }

// ---------- Public entry ----------
export function buildCourseFromPptx(buf: Buffer | Uint8Array, filename = ''): BuildResult {
  const { slides, warnings } = parsePptx(buf);
  const sections: Section[] = [];
  for (const s of slides) { const sec = slideToSection(s); if (sec) sections.push(sec); }
  const questions = buildQuestions(slides);

  const first = slides[0];
  const title = (first?.title || filename.replace(/\.pptx$/i, '') || 'Training module').slice(0, 200);
  const description = (first?.body?.[0]?.text || first?.notes || '').slice(0, 1000);

  // legacy quiz = MCQ + true/false (as 2-option) for the existing quiz flow
  const quiz = questions.flatMap(q => {
    if (q.type === 'mcq') return [{ q: q.q, opts: q.opts, answer: q.answer }];
    if (q.type === 'truefalse') return [{ q: q.q, opts: ['True', 'False'], answer: q.answer ? 0 : 1 }];
    return [];
  }).slice(0, 20);

  return { title, description, course: { version: 1, sections, questions }, quiz, slideCount: slides.length, warnings };
}
