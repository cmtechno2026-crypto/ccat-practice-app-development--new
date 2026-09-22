import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Loading, ErrorBox, Modal } from '../components/ui';

// Teacher Practice / Exam browse — the SAME published content the web CCAT client shows, but a teacher
// isn't tied to one grade, so they pick the grade on top. Practice = battery → subcategory → set;
// Exam = flat paper list. "Preview" opens the questions with correct answers (read-only). "Start" (run
// the quiz live) is Phase 2 — the button is present but disabled until the teacher-session path lands.

const BATTERY_ORDER = ['verbal', 'quantitative', 'non_verbal'];
const BATTERY_VIS: Record<string, { name: string; icon: string; color: string; tint: string }> = {
  verbal: { name: 'Verbal reasoning', icon: '🔤', color: '#3e7bee', tint: '#eaf0ff' },
  quantitative: { name: 'Quantitative reasoning', icon: '🔢', color: '#22c3a6', tint: '#e8f7f1' },
  non_verbal: { name: 'Non-verbal reasoning', icon: '🧩', color: '#8b5cf6', tint: '#f3ecfb' },
};

// Blocks store text in { type:'text', value } and images in { type:'image', url } (same model as the
// student Progress page / Student Detail set-review).
function blockText(blocks: any): string {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b: any) => b && b.type === 'text' && typeof b.value === 'string').map((b: any) => b.value).join(' ').trim();
}

const GRADE_KEY = 'ccat_admin_teacher_grade';

export function TeacherPractice() { return <TeacherContent mode="practice" />; }
export function TeacherExam() { return <TeacherContent mode="exam" />; }

function TeacherContent({ mode }: { mode: 'practice' | 'exam' }) {
  const [grades, setGrades] = useState<{ id: string; grade_number: number; name: string }[]>([]);
  const [gradeId, setGradeId] = useState<string>(() => { try { return localStorage.getItem(GRADE_KEY) || ''; } catch { return ''; } });
  const [items, setItems] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);

  // Browse position (practice only): which battery / subcategory is open.
  const [battery, setBattery] = useState<string | null>(null);
  const [sub, setSub] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; label: string } | null>(null);
  const [running, setRunning] = useState<{ id: string; label: string; isExam: boolean; duration: number | null } | null>(null);

  useEffect(() => {
    api.publicGrades().then(gs => {
      const sorted = [...gs].sort((a, b) => a.display_order - b.display_order || a.grade_number - b.grade_number);
      setGrades(sorted);
      setGradeId(prev => prev || sorted[0]?.id || '');
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!gradeId) return;
    try { localStorage.setItem(GRADE_KEY, gradeId); } catch { /* ignore */ }
    setLoading(true); setError(null); setBattery(null); setSub(null);
    api.teacherCatalog(gradeId).then(setItems).catch(setError).finally(() => setLoading(false));
  }, [gradeId]);

  const forMode = useMemo(() => (items ?? []).filter(i => i.allowed_modes?.includes(mode)), [items, mode]);

  // battery_key -> subcategory -> sets (practice)
  const grouped = useMemo(() => {
    const g: Record<string, Record<string, any[]>> = {};
    for (const c of forMode) { (g[c.category_key] ??= {}); (g[c.category_key][c.subcategory || '—'] ??= []).push(c); }
    return g;
  }, [forMode]);

  const gradeName = grades.find(g => g.id === gradeId);
  const gradeLabel = gradeName ? (gradeName.name || `Grade ${gradeName.grade_number}`) : '';

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
      <b style={{ fontSize: 16 }}>{mode === 'practice' ? 'Practice' : 'Exam'}</b>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--tint, #eef4fd)', border: '1px solid #d5e3f7', borderRadius: 12, padding: '7px 12px', fontWeight: 700, color: 'var(--primary, #1A5EAB)', fontSize: 13 }}>
        Grade
        <select value={gradeId} onChange={e => setGradeId(e.target.value)} style={{ border: '1px solid #cbdcf3', borderRadius: 8, padding: '5px 8px', fontWeight: 700, color: 'var(--primary, #1A5EAB)', background: '#fff', fontFamily: 'inherit' }}>
          {grades.length === 0 && <option value="">Loading…</option>}
          {grades.map(g => <option key={g.id} value={g.id}>{g.name || `Grade ${g.grade_number}`}</option>)}
        </select>
      </span>
    </div>
  );

  const setRow = (s: any) => (
    <div key={s.set_version_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', border: '1px solid var(--line, #e4e9f2)', borderRadius: 12, marginTop: 9 }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--green, #16a34a)' }} />
      <span>
        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{s.name}</div>
        <div className="muted" style={{ fontSize: 11.5 }}>{s.question_count} question{s.question_count === 1 ? '' : 's'}{s.difficulty ? ` · ${s.difficulty}` : ''}{mode === 'exam' && s.duration_minutes ? ` · ${s.duration_minutes} min` : ''}</div>
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        <button className="btn ghost sm" onClick={() => setPreview({ id: s.set_version_id, label: s.name })}>Preview</button>
        <button className="btn sm" onClick={() => setRunning({ id: s.set_version_id, label: s.name, isExam: mode === 'exam', duration: s.duration_minutes })}>Start</button>
      </span>
    </div>
  );

  return (
    <div>
      {header}

      {loading ? <Loading /> : error ? <ErrorBox e={error} /> : !items ? null : forMode.length === 0 ? (
        <div className="empty">No published {mode} content for {gradeLabel || 'this grade'} yet.</div>
      ) : mode === 'exam' ? (
        // EXAM — flat paper list grouped by battery.
        <div className="panel" style={{ padding: 16 }}>
          {BATTERY_ORDER.filter(k => grouped[k]).map(k => {
            const vis = BATTERY_VIS[k]; const papers = Object.values(grouped[k]).flat();
            return (
              <div key={k} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ width: 30, height: 30, borderRadius: 9, background: vis.tint, display: 'grid', placeItems: 'center', fontSize: 16 }}>{vis.icon}</span>
                  <b style={{ fontSize: 14 }}>{vis.name}</b>
                </div>
                {papers.map(setRow)}
              </div>
            );
          })}
        </div>
      ) : battery == null ? (
        // PRACTICE level 1 — the three batteries.
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
          {BATTERY_ORDER.filter(k => grouped[k]).map(k => {
            const vis = BATTERY_VIS[k]; const count = Object.values(grouped[k]).flat().length;
            const subs = Object.keys(grouped[k]);
            return (
              <button key={k} onClick={() => { setBattery(k); setSub(subs[0] ?? null); }}
                style={{ textAlign: 'left', border: '1px solid var(--line, #e4e9f2)', borderRadius: 16, padding: 16, background: 'var(--card, #fff)', cursor: 'pointer', position: 'relative' }}>
                <span style={{ position: 'absolute', top: 14, right: 14, fontSize: 11, fontWeight: 800, color: '#33405c', background: '#f3f6fb', borderRadius: 8, padding: '3px 8px' }}>{count} set{count === 1 ? '' : 's'}</span>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: vis.tint, display: 'grid', placeItems: 'center', fontSize: 22, marginBottom: 10 }}>{vis.icon}</div>
                <div style={{ fontWeight: 800, fontSize: 14.5 }}>{vis.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>{subs.slice(0, 3).join(' · ')}</div>
              </button>
            );
          })}
        </div>
      ) : (
        // PRACTICE level 2/3 — subcategory tabs + set rows.
        <div>
          <div style={{ fontSize: 12, color: 'var(--muted, #6b7280)', marginBottom: 10 }}>
            <button className="btn ghost sm" onClick={() => { setBattery(null); setSub(null); }}>← All batteries</button>
            <span style={{ marginLeft: 10 }}><b style={{ color: '#33405c' }}>{BATTERY_VIS[battery]?.name || battery}</b></span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            {Object.keys(grouped[battery] || {}).map(sk => (
              <button key={sk} onClick={() => setSub(sk)}
                className="chipbtn" style={sub === sk ? { background: 'var(--primary, #1A5EAB)', color: '#fff', borderColor: 'var(--primary, #1A5EAB)' } : undefined}>
                {sk} <span style={{ opacity: .7 }}>· {grouped[battery][sk].length}</span>
              </button>
            ))}
          </div>
          <div className="panel" style={{ padding: 14, marginTop: 8 }}>
            {(grouped[battery]?.[sub || ''] || []).map(setRow)}
          </div>
        </div>
      )}

      {preview && <PreviewModal setId={preview.id} label={preview.label} onClose={() => setPreview(null)} />}
      {running && <QuizRunner setId={running.id} label={running.label} isExam={running.isExam} durationMin={running.duration} onClose={() => setRunning(null)} />}
    </div>
  );
}

// Ephemeral quiz runner — the teacher takes the set live (one question at a time, optional exam timer),
// scored ENTIRELY in the browser against the answers already in the payload. Nothing is written to the
// server: no session, no answers, no analytics. Closing discards the attempt.
function QuizRunner({ setId, label, isExam, durationMin, onClose }: { setId: string; label: string; isExam: boolean; durationMin: number | null; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({}); // qIndex -> chosen option_id
  const [submitted, setSubmitted] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null); // seconds (exam only)

  useEffect(() => { setLoading(true); api.teacherSetPreview(setId).then(setData).catch(setError).finally(() => setLoading(false)); }, [setId]);

  // Exam timer: start once data is loaded; auto-submit at 0.
  useEffect(() => {
    if (!data || !isExam || !durationMin || submitted) return;
    setRemaining(prev => prev ?? durationMin * 60);
    const t = window.setInterval(() => setRemaining(r => (r == null ? r : Math.max(0, r - 1))), 1000);
    return () => window.clearInterval(t);
  }, [data, isExam, durationMin, submitted]);
  useEffect(() => { if (remaining === 0 && !submitted) setSubmitted(true); }, [remaining, submitted]);

  const questions: any[] = data?.questions ?? [];
  const score = useMemo(() => {
    let correct = 0;
    questions.forEach((q, i) => { const chosen = answers[i]; if (chosen && q.options?.find((o: any) => o.option_id === chosen)?.correct) correct++; });
    return { correct, total: questions.length };
  }, [questions, answers]);

  const overlay = (children: React.ReactNode) => (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg, #eef1f7)', zIndex: 60, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--line, #e4e9f2)', background: 'var(--card, #fff)' }}>
        <b style={{ fontSize: 15 }}>{label}</b>
        <span className="tag">{isExam ? 'Exam' : 'Practice'} · staff preview</span>
        {isExam && remaining != null && !submitted && (
          <span style={{ fontWeight: 800, color: remaining < 60 ? 'var(--coral,#e0533d)' : remaining < 180 ? 'var(--amber,#e0a030)' : 'var(--green,#16a34a)' }}>
            ⏳ {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
          </span>
        )}
        <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>✕ Close</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '18px', maxWidth: 820, width: '100%', margin: '0 auto' }}>{children}</div>
    </div>
  );

  if (loading) return overlay(<Loading />);
  if (error) return overlay(<ErrorBox e={error} />);
  if (questions.length === 0) return overlay(<div className="empty">This set has no questions.</div>);

  if (submitted) {
    const pct = questions.length ? Math.round((100 * score.correct) / questions.length) : 0;
    return overlay(
      <div>
        <div className="panel" style={{ padding: 20, textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: 'var(--muted,#6b7280)' }}>Your score (not saved)</div>
          <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--primary,#1A5EAB)' }}>{score.correct} / {questions.length}</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: pct >= 70 ? 'var(--green,#16a34a)' : pct >= 45 ? 'var(--amber,#e0a030)' : 'var(--coral,#e0533d)' }}>{pct}%</div>
        </div>
        {questions.map((q, i) => {
          const chosen = answers[i];
          const expl = blockText(q.explanation_blocks);
          return (
            <div key={q.question_version_id} style={{ padding: '12px 0', borderBottom: '1px solid var(--line, #eee)' }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Q{i + 1}. {blockText(q.prompt_blocks)}</div>
              {q.image_url && <img src={q.image_url} alt="" style={{ maxWidth: 340, display: 'block', margin: '8px 0', borderRadius: 8 }} />}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {(q.options || []).map((o: any, j: number) => {
                  const isChosen = chosen === o.option_id;
                  const bg = o.correct ? '#dcfce7' : (isChosen ? '#fee2e2' : 'var(--card, #fff)');
                  const bc = o.correct ? '#86efac' : (isChosen ? '#fca5a5' : 'var(--line, #d0d0d0)');
                  const col = o.correct ? '#166534' : (isChosen ? '#991b1b' : 'inherit');
                  return (
                    <span key={o.option_id || j} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid', borderColor: bc, background: bg, color: col, fontWeight: (o.correct || isChosen) ? 700 : 400, borderRadius: 8, padding: '4px 10px', fontSize: 13 }}>
                      {o.image_url ? <img src={o.image_url} alt="" style={{ maxWidth: 90, display: 'block' }} /> : (blockText(o.content) || o.option_id)}
                      {o.correct ? ' ✓' : (isChosen ? ' ✗' : '')}
                    </span>
                  );
                })}
              </div>
              {expl && <div style={{ marginTop: 8, background: '#eef3fc', border: '1px solid #d9e4f7', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}><b>Why:</b> {expl}</div>}
            </div>
          );
        })}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn ghost" onClick={() => { setSubmitted(false); setAnswers({}); setIdx(0); setRemaining(isExam && durationMin ? durationMin * 60 : null); }}>Retake</button>
          <button className="btn" onClick={onClose}>Done</button>
        </div>
      </div>
    );
  }

  const q = questions[idx];
  const answeredCount = Object.keys(answers).length;
  return overlay(
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Question {idx + 1} of {questions.length}</span>
        <span className="muted" style={{ fontSize: 12.5, marginLeft: 'auto' }}>{answeredCount} answered</span>
      </div>
      <div className="panel" style={{ padding: 18 }}>
        <div style={{ fontWeight: 700, fontSize: 15.5 }}>{blockText(q.prompt_blocks)}</div>
        {q.image_url && <img src={q.image_url} alt="" style={{ maxWidth: 360, display: 'block', margin: '10px 0', borderRadius: 8 }} />}
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {(q.options || []).map((o: any, j: number) => {
            const chosen = answers[idx] === o.option_id;
            return (
              <button key={o.option_id || j} onClick={() => setAnswers(a => ({ ...a, [idx]: o.option_id }))}
                style={{ textAlign: 'left', border: '1px solid', borderColor: chosen ? 'var(--primary,#1A5EAB)' : 'var(--line,#e4e9f2)', background: chosen ? 'var(--tint,#eef4fd)' : 'var(--card,#fff)', borderRadius: 10, padding: '10px 14px', fontSize: 14, cursor: 'pointer', fontWeight: chosen ? 700 : 400, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid', borderColor: chosen ? 'var(--primary,#1A5EAB)' : '#c8ced9', background: chosen ? 'var(--primary,#1A5EAB)' : 'transparent', flexShrink: 0 }} />
                {o.image_url ? <img src={o.image_url} alt="" style={{ maxWidth: 120, display: 'block' }} /> : (blockText(o.content) || o.option_id)}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
        <button className="btn ghost" disabled={idx === 0} onClick={() => setIdx(i => Math.max(0, i - 1))}>← Previous</button>
        {idx < questions.length - 1
          ? <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setIdx(i => Math.min(questions.length - 1, i + 1))}>Next →</button>
          : <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setSubmitted(true)}>Submit ({answeredCount}/{questions.length})</button>}
      </div>
    </div>
  );
}

function PreviewModal({ setId, label, onClose }: { setId: string; label: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  useEffect(() => { setLoading(true); api.teacherSetPreview(setId).then(setData).catch(setError).finally(() => setLoading(false)); }, [setId]);

  return (
    <Modal title={`Preview — ${label}`} onClose={onClose} wide
      footer={<button className="btn grow" onClick={onClose}>Close</button>}>
      {loading ? <Loading /> : error ? <ErrorBox e={error} /> : !data ? null : (
        <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            {data.category_name}{data.subcategory ? ` · ${data.subcategory}` : ''} · {data.questions.length} question{data.questions.length === 1 ? '' : 's'}
            {data.is_exam && data.duration_minutes ? ` · ${data.duration_minutes} min (exam)` : ''} · answers shown
          </div>
          {data.questions.map((q: any, i: number) => {
            const expl = blockText(q.explanation_blocks);
            return (
              <div key={q.question_version_id} style={{ padding: '12px 0', borderBottom: '1px solid var(--line, #eee)' }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>Q{i + 1}. {blockText(q.prompt_blocks)}</div>
                {q.image_url && <img src={q.image_url} alt="" style={{ maxWidth: 340, display: 'block', margin: '8px 0', borderRadius: 8 }} />}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  {(q.options || []).map((o: any, j: number) => (
                    <span key={o.option_id || j} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid', borderColor: o.correct ? '#86efac' : 'var(--line, #d0d0d0)',
                      background: o.correct ? '#dcfce7' : 'var(--card, #fff)', color: o.correct ? '#166534' : 'inherit',
                      fontWeight: o.correct ? 700 : 400, borderRadius: 8, padding: '4px 10px', fontSize: 13,
                    }}>
                      {o.image_url ? <img src={o.image_url} alt="" style={{ maxWidth: 90, display: 'block' }} /> : (blockText(o.content) || o.option_id)}
                      {o.correct ? ' ✓' : ''}
                    </span>
                  ))}
                </div>
                {expl && <div style={{ marginTop: 8, background: '#eef3fc', border: '1px solid #d9e4f7', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}><b>Why:</b> {expl}</div>}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
