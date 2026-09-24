import { useNavigate } from 'react-router-dom';
import type { Assignment } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { useAsync, Loader } from './ui';
import { assignmentTitle, assignDateStamp, batteryVis, openAssignment } from '../lib/assignments';

// HOME — Assignment panel. Sits in the slot that used to hold the Coins/XP/Badges stat tiles: a compact,
// scrollable agenda of the sets a teacher assigned to this child. Incomplete sets (assigned / in
// progress) are grouped on top under "To do"; finished sets fall under "Completed". "View all →" opens
// the full Assignments page. Every value is real gateway data; a brand-new account with no assignments
// renders a friendly empty state.
export function AssignmentPanel() {
  const nav = useNavigate();
  const { flash } = useApp();
  const { data, loading, error } = useAsync(() => client.assignments());

  const items = data ?? [];
  const todo = items.filter((a) => a.status !== 'done');
  const done = items.filter((a) => a.status === 'done');

  return (
    <section className="asgn-panel" aria-label="My assignments">
      <div className="asgn-head">
        <div className="asgn-title">📋 My Assignments{todo.length > 0 && <span className="asgn-count">{todo.length} to do</span>}</div>
        <button className="asgn-viewall" onClick={() => nav('/assignments')}>View all →</button>
      </div>

      {loading && <div className="asgn-body"><Loader /></div>}
      {error && !loading && (
        <div className="asgn-empty">Couldn’t load your assignments right now.</div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="asgn-empty">
          <span className="asgn-empty-ic" aria-hidden>🗒️</span>
          No assignments yet — your teacher hasn’t assigned any sets.
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="asgn-scroll">
          {todo.length > 0 && (
            <>
              <div className="asgn-group asgn-group-todo">● To do ({todo.length})</div>
              {todo.map((a) => <TodoRow key={a.id} a={a} nav={nav} flash={flash} compact />)}
            </>
          )}
          {done.length > 0 && (
            <>
              <div className="asgn-group asgn-group-done">● Completed ({done.length})</div>
              {done.map((a) => <DoneRow key={a.id} a={a} compact />)}
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ---- rows (shared shape between the Home panel and the full page; `compact` trims the page-only bits) ----

export function TodoRow({ a, nav, flash, compact }: { a: Assignment; nav: ReturnType<typeof useNavigate>; flash: (m: string) => void; compact?: boolean }) {
  const stamp = assignDateStamp(a.assigned_at);
  const vis = batteryVis(a.category_key);
  const cont = a.status === 'in_progress';
  return (
    <div className="asgn-row">
      <div className="asgn-date" style={{ color: vis.color, background: vis.tint }}>
        <span className="asgn-d">{stamp.day}</span><span className="asgn-m">{stamp.mon}</span>
      </div>
      <div className="asgn-main">
        <div className="asgn-name">{assignmentTitle(a)}</div>
        <div className="asgn-sub">
          <b>{a.category_name}</b> · {a.teacher_name ?? 'Your teacher'}
          {cont && a.progress ? ` · ${a.progress.answered}/${a.progress.total}` : ''}
          {!compact && a.question_count ? ` · ${a.question_count} questions` : ''}
        </div>
      </div>
      <button className="asgn-start" onClick={() => openAssignment(a, nav, flash)}>
        {cont ? 'Continue' : 'Start'}
      </button>
    </div>
  );
}

export function DoneRow({ a, compact }: { a: Assignment; compact?: boolean }) {
  const nav = useNavigate();
  const stamp = assignDateStamp(a.result?.finishedAt ?? a.assigned_at);
  return (
    <div className="asgn-row asgn-done">
      <div className="asgn-date asgn-date-done">
        <span className="asgn-d">{stamp.day}</span><span className="asgn-m">{stamp.mon}</span>
      </div>
      <div className="asgn-main">
        <div className="asgn-name">{assignmentTitle(a)}</div>
        <div className="asgn-sub">
          <b>{a.category_name}</b>
          {a.result ? ` · ${a.result.score.correct}/${a.result.score.total}` : ''}
          {a.result?.accuracyPct != null ? ` · ${a.result.accuracyPct}%` : ''}
        </div>
      </div>
      {!compact
        ? <button className="asgn-start asgn-review" onClick={() => nav('/progress')}>Review</button>
        : <span className="asgn-tick" aria-hidden>✓</span>}
    </div>
  );
}
