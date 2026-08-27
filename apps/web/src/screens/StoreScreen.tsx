import { useMemo, useState } from 'react';
import type { Book, Grade } from '@ccat/api-client';
import { ApiError } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Card, Loader, ErrorNote, useAsync, Field } from '../components/ui';

const SUBJECT_META: Record<string, { icon: string; color: string }> = {
  English: { icon: '📗', color: 'var(--green)' },
  Math: { icon: '📘', color: 'var(--primary)' },
  Mathematics: { icon: '📘', color: 'var(--primary)' },
  Science: { icon: '📙', color: 'var(--amber)' },
};
const money = (cents?: number | null) => (cents == null ? null : `$${(cents / 100).toFixed(2)}`);
const pctOff = (price?: number | null, orig?: number | null) =>
  price != null && orig != null && orig > price ? Math.round((1 - price / orig) * 100) : null;

// Book store → ADULT CHALLENGE gate → retailer handoff to allowlisted HTTPS only (Blueprint §21).
export function StoreScreen() {
  const { flash } = useApp();
  const { loading, error, data, reload } = useAsync(async () => {
    const [books, grades] = await Promise.all([client.books(), client.grades().catch(() => [] as Grade[])]);
    return { books, grades };
  }, []);
  const [gate, setGate] = useState<{ book: Book; token: string; prompt: string; retailerId?: string } | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [gradeF, setGradeF] = useState('all');
  const [subjectF, setSubjectF] = useState('all');

  const grades = data?.grades ?? [];
  const gradeNum = (id: string) => grades.find((g) => g.id === id)?.grade_number;
  const gradeLabel = (b: Book) => (b.grade_ids ?? []).map(gradeNum).filter(Boolean).map((n) => `Grade ${n}`).join(', ');

  const subjects = useMemo(() => Array.from(new Set((data?.books ?? []).map((b) => b.subject).filter(Boolean))) as string[], [data]);
  const gradeOpts = useMemo(() => Array.from(new Set((data?.books ?? []).flatMap((b) => b.grade_ids ?? []).map(gradeNum).filter(Boolean))).sort() as number[], [data, grades]);

  const shown = useMemo(() => (data?.books ?? []).filter((b) =>
    (subjectF === 'all' || b.subject === subjectF) &&
    (gradeF === 'all' || (b.grade_ids ?? []).some((id) => String(gradeNum(id)) === gradeF)),
  ), [data, subjectF, gradeF]); // eslint-disable-line react-hooks/exhaustive-deps

  // group shown books by subject
  const grouped = useMemo(() => {
    const g: Record<string, Book[]> = {};
    shown.forEach((b) => { (g[b.subject ?? 'Other'] ??= []).push(b); });
    return g;
  }, [shown]);

  async function startBuy(book: Book, retailerId?: string) {
    setBusy(true);
    try {
      const ch = await client.bookAdultChallenge(book.id);
      setGate({ book, token: ch.challenge_token, prompt: ch.prompt, retailerId });
      setAnswer('');
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Could not start.'); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!gate) return;
    setBusy(true);
    try {
      const r = await client.bookRetailerHandoff(gate.book.id, gate.token, answer.trim(), gate.retailerId);
      window.open(r.destination_url, '_blank', 'noopener');
      setGate(null);
      flash('Opening retailer…');
    } catch (e) {
      flash(e instanceof ApiError && e.code === 'ADULT_CHALLENGE_FAILED' ? 'That answer was not correct — a grown-up should complete this.' : (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <>
      <AppBar title="Book store" sub="Practice books by grade & subject" back />
      <div className="content stack">
        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}
        {data && (
          <>
            {/* Grade filter */}
            <div>
              <div className="eyebrow" style={{ marginBottom: 6 }}>Grade</div>
              <div className="row" style={{ flexWrap: 'wrap' }} role="group" aria-label="Grade filter">
                <button className={`btn small ${gradeF === 'all' ? '' : 'secondary'}`} aria-pressed={gradeF === 'all'} onClick={() => setGradeF('all')}>All</button>
                {gradeOpts.map((n) => (
                  <button key={n} className={`btn small ${gradeF === String(n) ? '' : 'secondary'}`} aria-pressed={gradeF === String(n)} onClick={() => setGradeF(String(n))}>Grade {n}</button>
                ))}
              </div>
            </div>
            {/* Subject filter */}
            <div>
              <div className="eyebrow" style={{ marginBottom: 6 }}>Subject</div>
              <div className="row" style={{ flexWrap: 'wrap' }} role="group" aria-label="Subject filter">
                <button className={`btn small ${subjectF === 'all' ? '' : 'secondary'}`} aria-pressed={subjectF === 'all'} onClick={() => setSubjectF('all')}>All</button>
                {subjects.map((s) => {
                  const m = SUBJECT_META[s];
                  return <button key={s} className={`btn small ${subjectF === s ? '' : 'secondary'}`} aria-pressed={subjectF === s} style={subjectF === s && m ? { background: m.color } : m ? { color: m.color } : undefined} onClick={() => setSubjectF(s)}>{m?.icon} {s}</button>;
                })}
              </div>
            </div>

            {shown.length === 0 && <div className="empty">No books match this filter yet.</div>}

            {Object.entries(grouped).map(([subject, books]) => {
              const m = SUBJECT_META[subject] ?? { icon: '📚', color: 'var(--primary)' };
              return (
                <div key={subject}>
                  <div className="eyebrow" style={{ margin: '4px 2px 8px', color: m.color }}>{m.icon} {subject}</div>
                  <div className="stack" style={{ gap: 10 }}>
                    {books.map((b) => {
                      const off = pctOff(b.price_cents, b.original_price_cents);
                      return (
                        <Card key={b.id}>
                          <div className="row" style={{ alignItems: 'flex-start' }}>
                            <div className="ic" style={{ background: 'var(--amber-tint)' }}>{m.icon}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div className="between">
                                <h3>{b.title}</h3>
                                {off != null && <span className="pill" style={{ background: 'var(--coral-tint)', color: 'var(--coral)' }}>{off}% OFF</span>}
                              </div>
                              {b.author && <div className="muted">{b.author}{gradeLabel(b) ? ` · ${gradeLabel(b)}` : ''}</div>}
                              {b.description && <div className="hint">{b.description}</div>}
                              {money(b.price_cents) && (
                                <div className="row" style={{ gap: 8, marginTop: 6 }}>
                                  <strong style={{ color: 'var(--green)', fontSize: 16 }}>{money(b.price_cents)}</strong>
                                  {b.original_price_cents != null && b.original_price_cents > (b.price_cents ?? 0) && (
                                    <span className="muted" style={{ textDecoration: 'line-through' }}>{money(b.original_price_cents)}</span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                            {(b.retailers.length ? b.retailers : [{ id: '', retailer: 'Buy' }]).map((r) => (
                              <button key={r.id || 'default'} className="btn small" disabled={busy} onClick={() => startBuy(b, r.id || undefined)}>Buy · {r.retailer}</button>
                            ))}
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {gate && (
        <div className="modal-scrim" onClick={() => setGate(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Grown-up check 👋</h2>
            <p className="muted">Purchases open on a retailer's site. Only stores set up for you appear here. Please answer to continue:</p>
            <Field label={gate.prompt}><input className="input" inputMode="numeric" value={answer} onChange={(e) => setAnswer(e.target.value)} autoFocus /></Field>
            <button className="btn" disabled={!answer.trim() || busy} onClick={confirm} style={{ marginTop: 12 }}>Continue to retailer</button>
            <button className="btn ghost small" onClick={() => setGate(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
