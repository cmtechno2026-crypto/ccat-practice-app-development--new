import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { PracticeAttemptResult, SessionWithQuestions } from '@ccat/api-client';
import { ApiError } from '@ccat/api-client';
import { AnswerBuffer, blocksToText, mmss, remainingSeconds } from '@ccat/client-core';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Loader, ErrorNote, Card } from '../components/ui';
import { ContentBlocks } from '../components/ContentBlocks';

const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

// Per-question PRACTICE feedback state (exam leaves this empty and stays silent).
interface PQ {
  picks: string[];          // wrong options ruled out (disabled)
  locked: boolean;          // question committed → no more attempts
  correctId: string | null; // revealed correct option (only once locked)
  correctIds: string[];     // all revealed correct options (multi)
  explanation: string;      // authored explanation (blank if none)
  remaining: number;        // attempts remaining
  message: string;          // "Correct!" / "Not quite — try again" / hint / reveal note
  ok: boolean;              // answered correctly
  hint: string;             // authored hint (blank if none) — powers the 💡 panel
}

export function SessionScreen() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { flash } = useApp();
  const [sess, setSess] = useState<SessionWithQuestions | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [bookmarked, setBookmarked] = useState<Record<string, boolean>>({});
  // exam: silent selections + autosave; practice: per-question feedback
  const [examSel, setExamSel] = useState<Record<string, string[]>>({});
  const [pq, setPq] = useState<Record<string, PQ>>({});
  const [multiPicks, setMultiPicks] = useState<Record<string, string[]>>({}); // practice multi-select staging
  const [hintOpen, setHintOpen] = useState<Record<string, boolean>>({});
  const [quitConfirm, setQuitConfirm] = useState(false);
  // Exam batteries: null = the battery lobby; otherwise the active battery's category_key.
  const [examBattery, setExamBattery] = useState<string | null>(null);
  const [batteryDone, setBatteryDone] = useState<Record<string, boolean>>({});
  const bufRef = useRef<AnswerBuffer | null>(null);

  const isExam = sess?.mode === 'exam';

  useEffect(() => {
    let alive = true;
    client.getSession(id).then((s) => {
      if (!alive) return;
      setSess(s);
      bufRef.current = new AnswerBuffer(s.questions);
      const es: Record<string, string[]> = {};
      s.questions.forEach((q) => { if (q.selected_option_ids.length) es[q.question_version_id] = q.selected_option_ids; });
      setExamSel(es);
      // Resume where you left off: jump to the first UNANSWERED question (practice). Exam keeps its
      // battery-scoped flow. If everything is answered (or nothing is), stay at the start.
      if (s.mode !== 'exam') {
        const firstUnanswered = s.questions.findIndex((q) => q.selected_option_ids.length === 0);
        if (firstUnanswered > 0) setIdx(firstUnanswered);
      }
      setRemaining(remainingSeconds(s.deadline_at));
    }).catch((e) => setErr(e instanceof ApiError ? e.message : (e as Error).message));
    return () => { alive = false; };
  }, [id]);

  useEffect(() => {
    if (sess?.timer_type !== 'timed' || !sess.deadline_at) return;
    const t = setInterval(() => {
      const r = remainingSeconds(sess.deadline_at);
      setRemaining(r);
      if (r != null && r <= 0) { clearInterval(t); void submit(); }
    }, 1000);
    return () => clearInterval(t);
  }, [sess]); // eslint-disable-line react-hooks/exhaustive-deps

  const isExamMode = sess?.mode === 'exam';
  // Exam batteries = questions grouped by category, in a stable order.
  const BATTERY_ORDER = ['verbal', 'non_verbal', 'nonverbal', 'quantitative'];
  const batteries = useMemo(() => {
    if (!sess) return [] as { key: string; name: string; questions: SessionWithQuestions['questions'] }[];
    const map = new Map<string, { key: string; name: string; questions: SessionWithQuestions['questions'] }>();
    sess.questions.forEach((qq) => {
      const k = qq.category_key ?? 'other';
      const b = map.get(k) ?? { key: k, name: qq.category_name ?? k, questions: [] };
      b.questions.push(qq); map.set(k, b);
    });
    return Array.from(map.values()).sort((a, b) => BATTERY_ORDER.indexOf(a.key) - BATTERY_ORDER.indexOf(b.key));
  }, [sess]); // eslint-disable-line react-hooks/exhaustive-deps
  // Questions currently in view: a single battery in exam mode, else the whole session.
  const activeQuestions = (isExamMode && examBattery)
    ? (batteries.find((b) => b.key === examBattery)?.questions ?? [])
    : (sess?.questions ?? []);
  const q = activeQuestions[idx];
  const total = activeQuestions.length;

  // ---- PRACTICE: per-question attempt with instant feedback (single OR multi "pick all") ----
  async function attempt(selected: string | string[]) {
    if (!q) return;
    const qid = q.question_version_id;
    const cur = pq[qid];
    if (cur?.locked) return;
    const picksArr = Array.isArray(selected) ? selected : [selected];
    if (!Array.isArray(selected) && cur?.picks.includes(selected)) return;
    try {
      const r: PracticeAttemptResult = await client.practiceAttempt(id, qid, selected);
      setPq((prev) => {
        const p: PQ = prev[qid] ?? { picks: [], locked: false, correctId: null, correctIds: [], explanation: '', remaining: 2, message: '', ok: false, hint: '' };
        const next: PQ = { ...p, remaining: r.attemptsRemaining };
        if (r.correct) {
          next.ok = true; next.locked = true;
          next.correctId = picksArr[0] ?? null;
          next.message = 'Correct! 🎉';
        } else {
          next.picks = [...p.picks, ...picksArr];
          if (r.revealed) { next.locked = true; next.correctId = r.revealed.correctOptionId; next.message = 'Not quite — here’s why'; }
          else { next.message = r.attemptsRemaining > 0 ? 'Oops, not that one! That option is greyed out — you have 1 more try.' : 'Not quite — here’s why'; }
        }
        if (r.revealed) {
          next.correctIds = r.revealed.correctOptionIds ?? (r.revealed.correctOptionId ? [r.revealed.correctOptionId] : []);
          next.explanation = blocksToText(r.revealed.explanation);
        }
        if (r.hint) next.hint = r.hint;
        return { ...prev, [qid]: next };
      });
      if (Array.isArray(selected)) setMultiPicks((m) => ({ ...m, [qid]: [] }));
    } catch (e) {
      flash(e instanceof ApiError ? e.message : 'Could not check that answer.');
    }
  }
  const toggleMultiPick = (oid: string) => {
    if (!q) return; const qid = q.question_version_id;
    if (pq[qid]?.locked) return;
    setMultiPicks((m) => { const cur = m[qid] ?? []; return { ...m, [qid]: cur.includes(oid) ? cur.filter((x) => x !== oid) : [...cur, oid] }; });
  };

  // ---- EXAM: silent select + versioned autosave (no feedback) ----
  async function choose(optionId: string) {
    if (!q || !bufRef.current) return;
    const sel = [optionId];
    setExamSel((s) => ({ ...s, [q.question_version_id]: sel }));
    try {
      const write = bufRef.current.next(q.question_version_id, sel);
      const acks = await client.saveAnswers(id, [write]);
      acks.forEach((a) => bufRef.current!.accept(a.question_version_id, a.accepted_version));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE_ANSWER') { /* ignore */ }
      else flash('Could not save that answer — check your connection.');
    }
  }

  async function submit() {
    if (!sess || submitting) return;
    setSubmitting(true);
    try {
      await client.submit(id, `sub-${id}`, sess.session_version);
      nav(`/result/${id}`, { replace: true });
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'DEADLINE_PASSED' || e.code === 'SESSION_TERMINAL')) nav(`/result/${id}`, { replace: true });
      else { setSubmitting(false); flash(e instanceof ApiError ? e.message : 'Could not submit.'); }
    }
  }
  async function quit() {
    try { await client.abandon(id, true); } catch { /* ignore */ }
    flash('Progress saved.');
    nav('/home', { replace: true });
  }
  async function toggleBookmark() {
    if (!q) return;
    const lq = q.logical_question_id, on = !bookmarked[lq];
    setBookmarked((b) => ({ ...b, [lq]: on }));
    try { if (on) await client.addBookmark(lq); else await client.removeBookmark(lq); }
    catch { setBookmarked((b) => ({ ...b, [lq]: !on })); flash('Could not update bookmark.'); }
  }

  const answeredCount = useMemo(() => {
    if (!sess) return 0;
    return sess.questions.filter((qq) => (isExam ? examSel[qq.question_version_id]?.length : pq[qq.question_version_id]?.locked)).length;
  }, [sess, examSel, pq, isExam]);

  if (err) return (<><AppBar title="Session" back /><div className="content"><ErrorNote error={err} /></div></>);
  if (!sess) return (<><AppBar title="Session" back /><div className="content"><Loader /></div></>);

  // EXAM battery lobby — pick a battery to work through; the shared timer keeps running.
  const timerColorLobby = remaining != null && remaining < 60 ? 'var(--coral)' : (remaining != null && remaining < 180 ? 'var(--amber)' : 'var(--green)');
  const BATT_META: Record<string, { icon: string; tint: string }> = { verbal: { icon: '🔤', tint: 'var(--tint-blue)' }, non_verbal: { icon: '🧩', tint: 'var(--tint-lilac)' }, nonverbal: { icon: '🧩', tint: 'var(--tint-lilac)' }, quantitative: { icon: '🔢', tint: 'var(--tint-green)' } };
  if (isExamMode && examBattery === null) {
    const doneCount = batteries.filter((b) => batteryDone[b.key]).length;
    return (
      <>
        <AppBar title={sess.set_name ?? 'Exam'} sub={`Pick a battery · ${doneCount}/${batteries.length} completed`} back
          right={remaining != null ? <span className="pill" style={{ color: timerColorLobby }}>⏳ {mmss(remaining)}</span> : undefined} />
        <div className="content session-content stack">
          <div className="card" style={{ background: 'var(--tint-blue)' }}>
            <div className="muted">Work through each battery before time runs out. The timer keeps running across all of them.</div>
          </div>
          {batteries.map((b) => {
            const answered = b.questions.filter((qq) => examSel[qq.question_version_id]?.length).length;
            const done = !!batteryDone[b.key];
            const m = BATT_META[b.key] ?? { icon: '📝', tint: 'var(--tint-blue)' };
            return (
              <Card key={b.key}>
                <div className="row">
                  <div className="ic" style={{ background: m.tint }}>{m.icon}</div>
                  <div style={{ flex: 1 }}>
                    <h3 style={{ textTransform: 'capitalize' }}>{b.name.replace('_', '-')}</h3>
                    <div className="muted">{done ? `Completed · ${answered}/${b.questions.length} attempted` : answered ? `In progress · ${answered}/${b.questions.length}` : `Not started · ${b.questions.length} questions`}</div>
                  </div>
                  {done
                    ? <span className="pill" style={{ background: 'var(--tint-green)', color: 'var(--green)' }}>Done ✓</span>
                    : <button className="btn small" onClick={() => { setExamBattery(b.key); setIdx(0); }}>{answered ? 'Continue' : 'Start'}</button>}
                </div>
              </Card>
            );
          })}
          <button className="btn danger" disabled={submitting} onClick={submit}>{submitting ? '…' : 'End exam & see result'}</button>
        </div>
      </>
    );
  }
  if (!q) return (<><AppBar title="Session" back /><div className="content"><Loader /></div></>);

  const p = pq[q.question_version_id];
  const examChosen = examSel[q.question_version_id] ?? [];
  const timerColor = remaining != null && remaining < 60 ? 'var(--coral)' : (remaining != null && remaining < 180 ? 'var(--amber)' : 'var(--green)');
  // Option A fixed difficulty palette — Easy green · Medium amber · Hard coral.
  const diffColor = { easy: '#22a06b', medium: '#d9902a', hard: '#e4574f' }[(sess.difficulty ?? '').toLowerCase()] ?? 'var(--primary)';
  const isMulti = !isExam && q.multi === true;
  const myMulti = multiPicks[q.question_version_id] ?? [];
  const subLine = [sess.subcategory, sess.set_name].filter(Boolean).join(' · ');

  return (
    <>
      <AppBar title={isExam ? 'Exam' : 'Practice'}
        sub={isExamMode && examBattery ? `${(batteries.find((b) => b.key === examBattery)?.name ?? '').replace('_', '-')} battery · Question ${idx + 1} of ${total}` : `${subLine ? subLine + ' · ' : ''}Question ${idx + 1} of ${total}`}
        back
        right={(
          <span className="row" style={{ gap: 6 }}>
            {sess.difficulty && <span className="pill" style={{ background: 'transparent', color: diffColor, border: `1px solid ${diffColor}` }}>{sess.difficulty}</span>}
            {remaining != null && <span className="pill" style={{ color: timerColor }}>⏳ {mmss(remaining)}</span>}
          </span>
        )} />
      <div className="content session-content stack">
        <div className="seg-bar">
          {activeQuestions.map((qq, i) => {
            const st = pq[qq.question_version_id];
            const done = isExam ? examSel[qq.question_version_id]?.length : st?.locked;
            const okc = !isExam && st?.ok;
            const wrong = !isExam && st?.locked && !st?.ok;
            const bm = bookmarked[qq.logical_question_id];
            const bg = i === idx ? 'var(--amber)' : okc ? 'var(--teal)' : wrong ? 'var(--coral)' : bm ? 'var(--amber)' : done ? 'var(--primary)' : 'var(--line)';
            const visited = i <= idx || !!st || !!examSel[qq.question_version_id]?.length;
            return <button key={qq.question_version_id} className="seg segbtn" title={`Question ${i + 1}`} disabled={!visited} onClick={() => setIdx(i)} style={{ background: bg }} />;
          })}
        </div>
        {/* Progress legend (exam is silent → attempted/bookmarked/not-answered) */}
        <div className="seg-legend">
          {isExam ? (
            <>
              <span><i style={{ background: 'var(--primary)' }} />Attempted</span>
              <span><i style={{ background: 'var(--amber)' }} />Bookmarked</span>
              <span><i style={{ background: 'var(--line)' }} />Not answered</span>
            </>
          ) : (
            <>
              <span><i style={{ background: 'var(--teal)' }} />Correct</span>
              <span><i style={{ background: 'var(--coral)' }} />Wrong</span>
              <span><i style={{ background: 'var(--amber)' }} />Bookmarked</span>
              <span><i style={{ background: 'var(--line)' }} />Unanswered</span>
            </>
          )}
        </div>

        <div className="card question-card">
          <div className="between">
            <div className="eyebrow">{q.question_type}</div>
            <div className="row" style={{ gap: 6 }}>
              {!isExam && p?.hint && (
                <button className="btn small ghost" onClick={() => setHintOpen((h) => ({ ...h, [q.question_version_id]: !h[q.question_version_id] }))}>💡 {hintOpen[q.question_version_id] ? 'Hide' : 'Hint'}</button>
              )}
              <button className="btn small ghost" aria-pressed={!!bookmarked[q.logical_question_id]} onClick={toggleBookmark}
                style={{ filter: bookmarked[q.logical_question_id] ? 'none' : 'grayscale(1) opacity(.6)' }}>🔖 {bookmarked[q.logical_question_id] ? 'Bookmarked' : 'Bookmark'}</button>
            </div>
          </div>
          <h2 style={{ margin: '8px 0 4px' }}><ContentBlocks blocks={q.prompt_blocks} /></h2>
          {isMulti && <div className="muted">✔ Pick all correct answers, then Check.</div>}
        </div>

        {!isExam && p?.hint && hintOpen[q.question_version_id] && (
          <div className="feedback" data-tone="retry"><strong>💡 Hint</strong><div className="explanation">{p.hint}</div></div>
        )}

        <div className="options-grid" role={isExam ? 'radiogroup' : 'group'} aria-label="Answer options">
          {q.option_blocks.map((opt, oi) => {
            const oid = opt.option_id;
            let cls = 'option';
            let disabled = false;
            const revealedCorrect = !isExam && p?.locked && (p.correctId === oid || p.correctIds.includes(oid));
            if (isExam) {
              if (examChosen.includes(oid)) cls += ' chosen';
            } else if (isMulti && !p?.locked) {
              if (myMulti.includes(oid)) cls += ' chosen';
            } else if (p) {
              if (revealedCorrect) cls += ' correct';
              else if (p.picks.includes(oid)) cls += ' wrong';
              disabled = p.locked || p.picks.includes(oid);
            }
            const onClick = () => {
              if (isExam) return choose(oid);
              if (isMulti && !p?.locked) return toggleMultiPick(oid);
              return attempt(oid);
            };
            return (
              <button key={oid} className={cls} disabled={disabled}
                role={isExam ? 'radio' : undefined} aria-checked={isExam ? examChosen.includes(oid) : undefined} onClick={onClick}>
                <span className="key">{KEYS[oi]}</span>
                <span><ContentBlocks blocks={opt.content} /></span>
                {revealedCorrect && <span style={{ marginLeft: 'auto' }}>✅</span>}
                {!isExam && p?.picks.includes(oid) && !revealedCorrect && <span style={{ marginLeft: 'auto' }}>❌</span>}
              </button>
            );
          })}
        </div>

        {isMulti && !p?.locked && (
          <button className="btn" disabled={myMulti.length === 0} onClick={() => attempt(myMulti)}>Check answer</button>
        )}

        {/* PRACTICE feedback panel */}
        {!isExam && p?.message && (
          <div className="feedback" data-tone={p.ok ? 'ok' : p.locked ? 'reveal' : 'retry'}>
            <strong>{p.message}</strong>
            {p.locked && p.explanation && <div className="explanation">{p.explanation}</div>}
          </div>
        )}

        <div className="between">
          <button className="btn secondary small" disabled={idx === 0} onClick={() => setIdx((i) => Math.max(0, i - 1))}>‹ Prev</button>
          <span className="muted">{activeQuestions.filter((qq) => (isExam ? examSel[qq.question_version_id]?.length : pq[qq.question_version_id]?.locked)).length}/{total} {isExam ? 'answered' : 'done'}</span>
          {idx < total - 1
            ? <button className="btn small" onClick={() => setIdx((i) => Math.min(total - 1, i + 1))}>Next ›</button>
            : isExamMode
              ? <button className="btn small" onClick={() => { if (examBattery) setBatteryDone((d) => ({ ...d, [examBattery]: true })); setExamBattery(null); setIdx(0); }}>End this battery ✅</button>
              : <button className="btn small" disabled={submitting} onClick={submit}>{submitting ? '…' : 'Finish ✅'}</button>}
        </div>

        <button className="btn ghost small" onClick={() => (isExamMode ? (setExamBattery(null), setIdx(0)) : setQuitConfirm(true))}>{isExamMode ? '‹ Back to batteries' : 'Save & leave'}</button>
      </div>

      {quitConfirm && (
        <div className="modal-scrim" role="dialog" aria-label="Leave this set?" onClick={() => setQuitConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Leave this set? 🤔</h3>
            <p className="muted">Your progress is saved. You can come back to it later.</p>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn secondary" onClick={() => setQuitConfirm(false)}>Keep going</button>
              <button className="btn" onClick={quit}>Save &amp; leave</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
