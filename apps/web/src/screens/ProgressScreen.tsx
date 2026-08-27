import { client } from '../lib/api';
import { AppBar, Card, Loader, ErrorNote, useAsync } from '../components/ui';

export function ProgressScreen() {
  const { loading, error, data, reload } = useAsync(async () => {
    const [readiness, progress] = await Promise.all([client.readiness(), client.progress()]);
    return { readiness, progress };
  });
  return (
    <>
      <AppBar title="Progress" sub="Completion & readiness" back />
      <div className="content stack">
        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}
        {data && (
          <>
            <Card>
              <div className="eyebrow">Course completion</div>
              {data.progress.progress_pct == null ? (
                <div className="muted" style={{ marginTop: 8 }}>Not enough data yet — complete a set to see your progress.</div>
              ) : (
                <>
                  <div className="between" style={{ marginTop: 8 }}>
                    <strong>{data.progress.completed_count} / {data.progress.eligible_count} sets</strong>
                    <span className="pill">{data.progress.progress_pct}%</span>
                  </div>
                  <div className="progress-track" style={{ marginTop: 8 }}><div className="progress-fill" style={{ width: `${data.progress.progress_pct}%` }} /></div>
                </>
              )}
            </Card>
            <Card>
              <div className="eyebrow">Exam readiness</div>
              {data.readiness.insufficient_data ? (
                <div className="muted" style={{ marginTop: 8 }}>Building your readiness — keep practising. (Answered {data.readiness.window_questions} questions so far.)</div>
              ) : (
                <div className="between" style={{ marginTop: 8 }}>
                  <strong style={{ textTransform: 'capitalize' }}>{data.readiness.band ?? '—'}</strong>
                  <span className="pill">{data.readiness.readiness_pct}%</span>
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </>
  );
}
