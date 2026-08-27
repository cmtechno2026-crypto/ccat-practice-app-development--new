import { useState } from 'react';
import type { SupportCase } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Card, Loader, ErrorNote, useAsync } from '../components/ui';

// Static FAQ — honest help about how THIS app actually works (presentation, not fetched data).
const FAQ: { q: string; a: string }[] = [
  { q: 'What is the difference between Practice and Exam?', a: 'Practice lets you take one set at a time, with hints and instant feedback after each question. Exam is a timed, three-battery test (verbal, quantitative and non-verbal) that mirrors the real CCAT format — no hints, and it is scored at the end.' },
  { q: 'How do I earn coins and keep my streak?', a: 'You keep a daily streak by practising on consecutive days. Reaching streak milestones (3, 7, 14 and 30 days) grants bonus coins. Your balance, streak and the milestone ladder are on the Rewards page.' },
  { q: 'How do avatars and themes unlock?', a: 'Avatars evolve and themes unlock as you earn XP. Anything you have reached the XP for equips instantly from the avatar button in the top-right; locked items show how much XP they need.' },
  { q: 'What are bookmarks for?', a: 'Bookmark any question during practice to revisit it later from the Bookmarks page, where you can review the correct answer and explanation as study — it is not re-scored.' },
  { q: 'I forgot my PIN. What do I do?', a: 'Open My profile → Change / recover PIN. Recovery is verified by your guardian, since accounts belong to learners under a guardian.' },
];

function FaqItem({ item }: { item: { q: string; a: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <Card onClick={() => setOpen((o) => !o)}>
      <div className="between">
        <strong>{item.q}</strong>
        <span className={`ach-chev ${open ? 'up' : ''}`} aria-hidden>▸</span>
      </div>
      {open && <div className="muted" style={{ marginTop: 8 }}>{item.a}</div>}
    </Card>
  );
}

const stateLabel: Record<string, string> = { open: 'Open', closed: 'Resolved' };
const prettyDate = (iso: string) => { try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; } };

export function HelpScreen() {
  const { flash } = useApp();
  const [category, setCategory] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { loading, error, data, reload } = useAsync(async () => client.supportCases().catch(() => [] as SupportCase[]));

  async function submit() {
    const msg = message.trim();
    if (msg.length < 4) { flash('Please describe the problem (a few words).'); return; }
    setSubmitting(true);
    try {
      const res = await client.reportProblem(msg, category || undefined);
      flash(`Report sent — ref ${res.reference}`);
      setMessage(''); setCategory('');
      reload();
    } catch (e) { flash((e as Error).message); }
    finally { setSubmitting(false); }
  }

  return (
    <>
      <AppBar title="Help & support" sub="Find answers or report a problem" back />
      <div className="content stack">
        <div className="eyebrow">❓ Frequently asked</div>
        {FAQ.map((f) => <FaqItem key={f.q} item={f} />)}

        <Card>
          <div className="eyebrow">🛠️ Report a problem</div>
          <div className="muted" style={{ margin: '6px 0 10px' }}>Tell us what went wrong. Your report goes to the Concept Mastery team.</div>
          <label className="field" style={{ marginBottom: 10 }}>
            <span>Topic (optional)</span>
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">General</option>
              <option value="Practice">Practice</option>
              <option value="Exam">Exam</option>
              <option value="Login/PIN">Login / PIN</option>
              <option value="Rewards">Rewards & coins</option>
              <option value="Content">A question looks wrong</option>
            </select>
          </label>
          <label className="field" style={{ marginBottom: 10 }}>
            <span>What happened?</span>
            <textarea className="input" value={message} maxLength={1000} rows={4} placeholder="Describe the problem…"
              style={{ resize: 'vertical' }} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <div className="between">
            <span className="hint">{message.length}/1000</span>
            <button className="btn" disabled={submitting || message.trim().length < 4} onClick={submit}>
              {submitting ? 'Sending…' : 'Send report'}
            </button>
          </div>
        </Card>

        <div className="eyebrow">📨 Your reports</div>
        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}
        {data && data.length === 0 && <div className="muted">No reports yet.</div>}
        {data && data.map((c) => (
          <Card key={c.reference}>
            <div className="between">
              <div><strong>{c.reference}</strong><div className="muted" style={{ marginTop: 2 }}>{c.summary}</div></div>
              <div style={{ textAlign: 'right' }}>
                <span className="pill" style={c.state === 'open'
                  ? { background: 'var(--tint-blue)', color: 'var(--primary)' }
                  : { background: 'var(--tint-green)', color: 'var(--green, #22a06b)' }}>{stateLabel[c.state] ?? c.state}</span>
                <div className="hint" style={{ marginTop: 4 }}>{prettyDate(c.created_at)}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
