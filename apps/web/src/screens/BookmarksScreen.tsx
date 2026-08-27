import { useMemo, useState } from 'react';
import type { Bookmark, BookmarkReview } from '@ccat/api-client';
import { blocksToText } from '@ccat/client-core';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Card, Loader, ErrorNote, useAsync } from '../components/ui';

const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];
const CAT_ICON: Record<string, string> = { verbal: '🔤', non_verbal: '🧩', nonverbal: '🧩', quantitative: '🔢' };
const catIcon = (k: string) => CAT_ICON[k?.toLowerCase().replace(/[\s-]/g, '_')] ?? '📁';
const DIFF_COLOR: Record<string, string> = { easy: 'var(--green)', medium: 'var(--teal)', hard: 'var(--purple)' };
const diffColor = (d?: string | null) => (d ? DIFF_COLOR[d.toLowerCase()] ?? 'var(--primary)' : 'var(--muted)');
const prettyDate = (iso: string) => { try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; } };

// A tiny dropdown filter control (label + options with a ✓ on the active one).
function Filter({ label, value, options, onPick, disabled, open, setOpen }: {
  label: string; value: string; options: { v: string; t: string; icon?: string }[];
  onPick: (v: string) => void; disabled?: boolean; open: boolean; setOpen: (o: boolean) => void;
}) {
  const active = options.find((o) => o.v === value);
  return (
    <div className={`bm-filter ${disabled ? 'is-disabled' : ''}`}>
      <button className="bm-filter-btn" disabled={disabled} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="bm-filter-label">{label}</span>
        <span className="bm-filter-value">{active?.icon ? `${active.icon} ` : ''}{active?.t ?? 'All'}</span>
        <span className={`bm-chev ${open ? 'up' : ''}`} aria-hidden>▾</span>
      </button>
      {open && (
        <div className="bm-menu" role="menu">
          {options.map((o) => (
            <button key={o.v} role="menuitemradio" aria-checked={o.v === value} className={`bm-menu-item ${o.v === value ? 'on' : ''}`}
              onClick={() => { onPick(o.v); setOpen(false); }}>
              <span>{o.icon ? `${o.icon} ` : ''}{o.t}</span>
              {o.v === value && <span aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// In-list review player over a list of bookmarked logical-question ids. Fetches each question's
// full published payload (answer revealed — study, not a graded attempt) and lets the student
// check answers, see the explanation, navigate, and unbookmark.
function ReviewPlayer({ ids, onClose, onUnbookmark }: { ids: string[]; onClose: () => void; onUnbookmark: (id: string) => void }) {
  const { flash } = useApp();
  const [pos, setPos] = useState(0);
  const id = ids[pos] ?? ids[0]!;
  const { loading, error, data, reload } = useAsync<BookmarkReview>(() => client.bookmarkReview(id), [id]);
  const [picks, setPicks] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);
  const reset = () => { setPicks([]); setChecked(false); };
  const go = (d: number) => { setPos((p) => Math.min(ids.length - 1, Math.max(0, p + d))); reset(); };

  const correct = data?.correct_option_ids ?? [];
  const isMulti = correct.length > 1;
  const togglePick = (oid: string) => {
    if (checked) return;
    if (isMulti) setPicks((p) => (p.includes(oid) ? p.filter((x) => x !== oid) : [...p, oid]));
    else { setPicks([oid]); setChecked(true); }
  };
  const gotIt = checked && correct.length === picks.length && correct.every((c) => picks.includes(c));

  async function unbookmark() {
    try { await client.removeBookmark(id); onUnbookmark(id); flash('Removed from bookmarks'); onClose(); }
    catch { flash('Could not remove.'); }
  }

  return (
    <div className="bm-review" role="dialog" aria-label="Review bookmarked questions">
      <div className="bm-review-bar">
        <button className="btn small ghost" onClick={onClose}>‹ Back</button>
        {data && <span className="pill" style={{ background: 'transparent', color: diffColor(data.difficulty), border: `1px solid ${diffColor(data.difficulty)}` }}>{data.difficulty ?? 'Review'}</span>}
        <span className="pill">🔖 Review</span>
        <span className="muted" style={{ marginLeft: 'auto' }}>{pos + 1} of {ids.length}</span>
      </div>
      <div className="seg-bar" aria-hidden>
        {ids.map((_, i) => <div key={i} className="seg" style={{ background: i === pos ? 'var(--primary)' : 'var(--line)' }} />)}
      </div>
      {loading && <Loader />}
      {error && <ErrorNote error={error} onRetry={reload} />}
      {data && (
        <>
          <div className="card question-card">
            <div className="between">
              <div className="eyebrow">{data.subcategory}{data.set_name ? ` · ${data.set_name}` : ''}{data.position ? ` · Q${data.position}` : ''}</div>
              <button className="btn small ghost" onClick={unbookmark}>🔖 Unbookmark</button>
            </div>
            <h2 style={{ margin: '8px 0 4px' }}>{blocksToText(data.prompt_blocks)}</h2>
            {isMulti && <div className="muted">✔ Pick all correct answers, then Check.</div>}
          </div>
          <div className="options-grid" role="group" aria-label="Answer options">
            {(data.option_blocks as { option_id: string; content: unknown[] }[]).map((opt, oi) => {
              const oid = opt.option_id;
              let cls = 'option';
              if (checked) {
                if (correct.includes(oid)) cls += ' correct';
                else if (picks.includes(oid)) cls += ' wrong';
              } else if (picks.includes(oid)) cls += ' chosen';
              return (
                <button key={oid} className={cls} disabled={checked} onClick={() => togglePick(oid)}>
                  <span className="key">{KEYS[oi]}</span>
                  <span>{blocksToText(opt.content)}</span>
                  {checked && correct.includes(oid) && <span style={{ marginLeft: 'auto' }}>✅</span>}
                  {checked && !correct.includes(oid) && picks.includes(oid) && <span style={{ marginLeft: 'auto' }}>❌</span>}
                </button>
              );
            })}
          </div>
          {isMulti && !checked && (
            <button className="btn" disabled={picks.length === 0} onClick={() => setChecked(true)}>Check answer</button>
          )}
          {checked && (
            <div className="feedback" data-tone={gotIt ? 'ok' : 'reveal'}>
              <strong>{gotIt ? 'Correct! 🎉' : 'Here’s the answer'}</strong>
              {data.explanation_blocks && <div className="explanation">{blocksToText(data.explanation_blocks)}</div>}
              {!data.explanation_blocks && !gotIt && <div className="explanation">The correct answer is highlighted above.</div>}
            </div>
          )}
          <div className="between">
            <button className="btn secondary small" disabled={pos === 0} onClick={() => go(-1)}>‹ Prev</button>
            {!checked && !isMulti && <button className="btn ghost small" onClick={() => setChecked(true)}>Show answer</button>}
            {pos < ids.length - 1
              ? <button className="btn small" onClick={() => go(1)}>Next ›</button>
              : <button className="btn small" onClick={onClose}>Done</button>}
          </div>
        </>
      )}
    </div>
  );
}

export function BookmarksScreen() {
  const { flash } = useApp();
  const { loading, error, data, reload } = useAsync(() => client.bookmarks(), []);
  const [local, setLocal] = useState<Bookmark[] | null>(null);
  const list = local ?? data ?? [];

  const [cat, setCat] = useState('all');
  const [sub, setSub] = useState('all');
  const [set, setSet] = useState('all');
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<string[] | null>(null);

  const setLocalFrom = (next: Bookmark[]) => setLocal(next);
  const removeId = (id: string) => setLocalFrom(list.filter((x) => x.logical_question_id !== id));

  // Filter option lists derived from the data (category → topic dependent).
  const catOptions = useMemo(() => {
    const keys = Array.from(new Set(list.map((b) => b.category_key)));
    return [{ v: 'all', t: 'All categories', icon: '📁' }, ...keys.map((k) => ({ v: k, t: k.replace(/_/g, ' '), icon: catIcon(k) }))];
  }, [list]);
  const subOptions = useMemo(() => {
    const inCat = list.filter((b) => cat === 'all' || b.category_key === cat);
    const subs = Array.from(new Set(inCat.map((b) => b.subcategory)));
    return [{ v: 'all', t: 'All topics' }, ...subs.map((s) => ({ v: s, t: s }))];
  }, [list, cat]);
  const setOptions = useMemo(() => {
    const inScope = list.filter((b) => (cat === 'all' || b.category_key === cat) && (sub === 'all' || b.subcategory === sub));
    const sets = Array.from(new Set(inScope.map((b) => b.set_name).filter(Boolean))) as string[];
    return [{ v: 'all', t: 'All sets', icon: '#' }, ...sets.map((s) => ({ v: s, t: s, icon: '#' }))];
  }, [list, cat, sub]);

  const shown = useMemo(() => list.filter((b) =>
    (cat === 'all' || b.category_key === cat) &&
    (sub === 'all' || b.subcategory === sub) &&
    (set === 'all' || b.set_name === set),
  ), [list, cat, sub, set]);

  const allShownSelected = shown.length > 0 && shown.every((b) => selected.has(b.logical_question_id));
  const toggleAll = () => setSelected(allShownSelected ? new Set() : new Set(shown.map((b) => b.logical_question_id)));
  const toggleOne = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function bulkUnbookmark() {
    const ids = Array.from(selected);
    try {
      await Promise.all(ids.map((id) => client.removeBookmark(id)));
      setLocalFrom(list.filter((x) => !selected.has(x.logical_question_id)));
      setSelected(new Set()); setSelectMode(false);
      flash(`${ids.length} question(s) unbookmarked`);
    } catch { flash('Could not unbookmark all.'); }
  }

  if (review) return <ReviewPlayer ids={review} onClose={() => { setReview(null); reload(); }} onUnbookmark={removeId} />;

  const selectedCount = selected.size;

  return (
    <>
      <AppBar title="Bookmarks" sub={`📥 ${list.length} saved`} back
        right={list.length > 0 ? (
          <button className="btn small ghost" onClick={() => { setSelectMode(!selectMode); setSelected(new Set()); }}>
            {selectMode ? 'Done' : 'Select'}
          </button>
        ) : undefined} />
      <div className="content stack">
        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}
        {data && list.length === 0 && <div className="empty">🔖 No bookmarks here.<br />Tap the bookmark icon on any question to save it for later.</div>}

        {list.length > 0 && (
          <>
            <div className="bm-filters">
              <Filter label="Category" value={cat} options={catOptions} open={openFilter === 'cat'} setOpen={(o) => setOpenFilter(o ? 'cat' : null)}
                onPick={(v) => { setCat(v); setSub('all'); setSet('all'); }} />
              <Filter label="Topic" value={sub} options={subOptions} disabled={cat === 'all' && subOptions.length <= 1}
                open={openFilter === 'sub'} setOpen={(o) => setOpenFilter(o ? 'sub' : null)} onPick={(v) => { setSub(v); setSet('all'); }} />
              <Filter label="Set" value={set} options={setOptions} disabled={setOptions.length <= 1}
                open={openFilter === 'set'} setOpen={(o) => setOpenFilter(o ? 'set' : null)} onPick={setSet} />
            </div>
            <div className="between">
              <span className="muted">{shown.length} question(s) · newest first</span>
              {selectMode && (
                <button className="bm-selall" onClick={toggleAll}>
                  <span className={`bm-box ${allShownSelected ? 'on' : ''}`} aria-hidden>{allShownSelected ? '✓' : ''}</span> Select all
                </button>
              )}
            </div>
          </>
        )}

        {shown.map((b) => {
          const sel = selected.has(b.logical_question_id);
          return (
            <Card key={b.logical_question_id} onClick={selectMode ? () => toggleOne(b.logical_question_id) : () => setReview([b.logical_question_id])}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                {selectMode && <span className={`bm-box ${sel ? 'on' : ''}`} style={{ borderColor: diffColor(b.difficulty) }} aria-hidden>{sel ? '✓' : ''}</span>}
                <div className="ic" style={{ background: 'var(--tint-blue)', color: diffColor(b.difficulty) }}>{catIcon(b.category_key)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="muted" style={{ textTransform: 'capitalize' }}>{b.category_key.replace(/_/g, ' ')} · {b.subcategory}</div>
                  <strong>{b.preview}</strong>
                  <div className="hint" style={{ marginTop: 4 }}>
                    {b.set_name ?? 'Set'}{b.position ? ` · Q${b.position}` : ''} · 🔖 {prettyDate(b.created_at)}
                  </div>
                  {b.note && <div className="hint">Note: {b.note}</div>}
                </div>
                {!selectMode && <span style={{ color: diffColor(b.difficulty), alignSelf: 'center' }}>›</span>}
              </div>
            </Card>
          );
        })}
      </div>

      {selectMode && selectedCount > 0 && (
        <div className="bm-bulkbar">
          <div><strong>{selectedCount} selected</strong><div className="muted">Open to review or unbookmark</div></div>
          <div className="row">
            <button className="btn small ghost" onClick={bulkUnbookmark}>🔖 Unbookmark</button>
            <button className="btn small" onClick={() => setReview(Array.from(selected))}>Open ›</button>
          </div>
        </div>
      )}
    </>
  );
}
