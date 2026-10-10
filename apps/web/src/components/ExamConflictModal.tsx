import { useEffect, useState } from 'react';

// Live countdown for an in-progress exam — the server clock keeps running, so this shows the true
// remaining time and ticks every second, turning amber then red as it runs low. Shared by the
// Practice/Exam list (Resume card) and the exam-conflict popup.
export function ExamCountdown({ deadline }: { deadline: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  const rem = Math.max(0, Math.round((new Date(deadline).getTime() - now) / 1000));
  const mm = Math.floor(rem / 60), ss = rem % 60;
  const color = rem <= 0 ? 'var(--coral)' : rem < 60 ? 'var(--coral)' : rem < 180 ? 'var(--amber)' : 'var(--green)';
  return <span style={{ color, fontWeight: 700 }}>⏳ {rem <= 0 ? 'time up' : `${mm}:${String(ss).padStart(2, '0')}`}</span>;
}

export interface ExamConflictInfo {
  session_id: string;
  set_version_id: string;
  label: string;                  // e.g. "Verbal Reasoning · Set 2"
  duration_minutes?: number | null;
  answered?: number | null;
  total?: number | null;
  deadline_at?: string | null;
}

// "An exam is still in progress" dialog (Sample B): resume the running exam, or end it and start the new
// one. Shared by the Practice/Exam list AND the assignment surfaces, so both behave identically.
export function ExamConflictModal({ running, nextLabel, onResume, onEndStart, onClose }: {
  running: ExamConflictInfo;
  nextLabel: string;
  onResume: () => void;
  onEndStart: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-scrim" role="dialog" aria-label="Exam in progress" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 360, position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        <button aria-label="Close" onClick={onClose}
          style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 8, border: 0, background: 'var(--coral, #e0533d)', color: '#fff', fontSize: 16, fontWeight: 900, lineHeight: 1, cursor: 'pointer' }}>✕</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, paddingRight: 34 }}>
          <div style={{ width: 34, height: 34, flex: 'none', borderRadius: 10, background: 'var(--amber-bg, #fdf3e2)', color: 'var(--amber, #b7791f)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }} aria-hidden>⚠️</div>
          <h3 style={{ margin: 0, fontSize: 16.5 }}>An exam is still in progress</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, border: '1px solid var(--line, #e5e9f2)', borderRadius: 14, padding: '13px 14px', marginBottom: 16 }}>
          <div style={{ width: 4, alignSelf: 'stretch', borderRadius: 4, background: 'var(--primary, #2f6fd0)' }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 14.5 }}>{running.label}</div>
            <div style={{ fontSize: 12, color: 'var(--muted, #6b7389)', marginTop: 2 }}>Exam paper{running.duration_minutes ? ` · ${running.duration_minutes} min` : ''}{running.answered != null && running.total != null ? ` · ${running.answered} of ${running.total} answered` : ''}</div>
          </div>
          {running.deadline_at && (
            <div style={{ marginLeft: 'auto', textAlign: 'right', flex: 'none' }}>
              <div style={{ fontSize: 15, fontWeight: 900 }}><ExamCountdown deadline={running.deadline_at} /></div>
              <div style={{ fontSize: 10.5, color: 'var(--muted, #6b7389)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>left</div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <button className="btn" onClick={onResume}>↩ Resume this exam</button>
          <button className="btn" style={{ background: 'var(--coral, #e0533d)', color: '#fff' }} onClick={onEndStart}>End &amp; start {nextLabel}</button>
        </div>
      </div>
    </div>
  );
}
