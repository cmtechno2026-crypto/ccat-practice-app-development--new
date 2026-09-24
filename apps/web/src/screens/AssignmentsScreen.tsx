import { useNavigate } from 'react-router-dom';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { useAsync, Loader, ErrorNote } from '../components/ui';
import { TodoRow, DoneRow } from '../components/AssignmentPanel';

// ASSIGNMENTS PAGE — the full agenda of teacher-assigned sets (reached from the Home panel's "View all →"
// and the sidebar). Same source + ordering as the Home panel: incomplete ("To do") first, then completed.
// Rows are the shared TodoRow / DoneRow in non-compact form (question counts, Review button).
export function AssignmentsScreen() {
  const nav = useNavigate();
  const { flash } = useApp();
  const { data, loading, error, reload } = useAsync(() => client.assignments());

  const items = data ?? [];
  const todo = items.filter((a) => a.status !== 'done');
  const done = items.filter((a) => a.status === 'done');

  return (
    <div className="asgn-page">
      <header className="asgn-page-hero">
        <h1>📋 Assignments</h1>
        <p className="asgn-page-sub">Sets your teacher assigned to you. Finish the ones at the top first.</p>
      </header>

      {loading && <Loader />}
      {error && !loading && <ErrorNote error={error} onRetry={reload} />}

      {!loading && !error && items.length === 0 && (
        <div className="asgn-empty asgn-empty-page">
          <span className="asgn-empty-ic" aria-hidden>🗒️</span>
          You have no assignments yet. When a teacher assigns a set, it’ll appear here.
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="asgn-page-list">
          <div className="asgn-page-meta">{todo.length} to do · {done.length} done</div>
          {todo.length > 0 && (
            <>
              <div className="asgn-group asgn-group-todo">● To do</div>
              {todo.map((a) => <TodoRow key={a.id} a={a} nav={nav} flash={flash} />)}
            </>
          )}
          {done.length > 0 && (
            <>
              <div className="asgn-group asgn-group-done">● Completed</div>
              {done.map((a) => <DoneRow key={a.id} a={a} />)}
            </>
          )}
        </div>
      )}
    </div>
  );
}
