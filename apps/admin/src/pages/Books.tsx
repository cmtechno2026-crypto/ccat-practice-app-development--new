import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync, Panel, Modal, Loading, ErrorBox, useToast } from '../components/ui';

type Platform = { key: string; label: string; domains: string[] };

// Decorative cover tints, theme-token-based so they adapt to dark mode. Cycled per card to
// mirror the mockup's varied covers. Cover *upload* is not wired (no admin cover endpoint),
// so this is a visual placeholder only — see the honest-gap note in the card body.
const COVER_TINTS = ['var(--tint)', 'var(--green-bg)', 'var(--amber-bg)', 'var(--lilac)', 'var(--coral-bg)'];

export function Books() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api.books());
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [create, setCreate] = useState(false);
  const [editBook, setEditBook] = useState<any>(null);
  const [grades, setGrades] = useState<any[]>([]);
  const manage = can('book.manage');
  useEffect(() => { api.grades().then(r => setGrades(r.items)).catch(() => {}); }, []);
  // Only offer platforms that have at least one allowlisted domain (an entry with none can never validate).
  useEffect(() => { api.bookRetailers().then(r => setPlatforms(r.platforms.filter(p => p.domains.length))).catch(() => {}); }, []);
  const act = async (fn: Promise<any>, m: string) => { try { await fn; toast(m); reload(); } catch (e) { toast((e as Error).message); } };

  const items: any[] = data?.items || [];
  // BLUEPRINT-ADD: top stat row (mockup structure). Every figure is computed from the live list —
  // no fabricated metrics. "Buy links total" counts links across all books.
  const total = items.length;
  const live = items.filter(b => b.active).length;
  const linkTotal = items.reduce((n, b) => n + (b.retailers || []).length, 0);
  const drafts = total - live;

  const gradeLabels = (b: any): string[] => {
    const ids: string[] = b.grade_ids || [];
    if (!ids.length) return ['All grades'];
    return grades.filter(g => ids.includes(g.id)).map(g => `Grade ${g.grade_number}`);
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h2>Book Store</h2>
          <p className="lead">External retailer links only — no embedded checkout. Each book can carry several per-platform buy links; destinations must be HTTPS and on the retailer allowlist (§21).</p>
        </div>
        {manage && <button className="btn" style={{ flex: '0 0 auto', marginTop: 4 }} onClick={() => setCreate(true)}>+ Add book</button>}
      </div>

      {!loading && !error && (
        <div className="kpirow" style={{ marginTop: 14 }}>
          <Stat ico="📚" n={total} l="Books in the store" />
          <Stat ico="🟢" n={live} l="Live for sale" />
          <Stat ico="🛒" n={linkTotal} l="Buy links total" />
          <Stat ico="✏️" n={drafts} l="Drafts" />
        </div>
      )}

      <Panel>
        {loading ? <Loading /> : error ? <ErrorBox e={error} /> : items.length === 0 ? (
          <div className="empty">No books yet. Add one with at least one allowlisted retailer link.</div>
        ) : (
          <div className="bookgrid">
            {items.map((b, i) => (
              <BookCard key={b.id} book={b} tint={COVER_TINTS[i % COVER_TINTS.length]} grades={gradeLabels(b)}
                platforms={platforms} manage={manage} act={act} onEdit={() => setEditBook(b)} />
            ))}
          </div>
        )}
      </Panel>
      {create && <BookCreate platforms={platforms} onClose={() => setCreate(false)} onSaved={() => { setCreate(false); reload(); }} />}
      {editBook && <BookEditor book={editBook} grades={grades} onClose={() => setEditBook(null)} onSaved={() => { setEditBook(null); reload(); }} />}
    </>
  );
}

function Stat({ ico, n, l }: { ico: string; n: number; l: string }) {
  return <div className="kpi"><div className="ico">{ico}</div><div><div className="n tabnum">{n}</div><div className="l">{l}</div></div></div>;
}

function BookCard({ book, tint, grades, platforms, manage, act, onEdit }: {
  book: any; tint: string; grades: string[]; platforms: Platform[]; manage: boolean;
  act: (fn: Promise<any>, m: string) => void; onEdit: () => void;
}) {
  return (
    <div className="bookcard">
      {/* Cover is a decorative placeholder — no admin cover-upload endpoint exists, so there is no
          drop-to-upload control here (that would be a control with nothing behind it). */}
      <div className="bookcover" style={{ background: tint }}>
        <div className="cico">🖼️</div>
        <span className={`pill statepill ${book.active ? 'green' : ''}`}
          style={book.active ? { background: 'var(--green-bg)', color: 'var(--green)' } : { background: 'var(--card-2)', color: 'var(--muted)' }}>
          {book.active ? 'Live' : 'Draft'}
        </span>
      </div>
      <div className="bookbody">
        <div>
          <h4>{book.title}</h4>
          <div className="bauthor">{book.author || 'Concept Mastery'}</div>
        </div>
        <div className="bookmeta">
          {book.price_cents != null && <span className="pricepill">{fmtPrice(book.price_cents)}</span>}
          {grades.map(g => <span key={g} className="metapill">{g}</span>)}
          {book.subject && <span className="metapill">{book.subject}</span>}
        </div>
        <BookLinks book={book} platforms={platforms} manage={manage} act={act} />
        {manage && (
          <div className="bookfoot">
            <button className="btn ghost sm grow" onClick={onEdit}>Edit</button>
            <button className={`btn sm ${book.active ? 'warn' : 'green'}`}
              onClick={() => act(api.patchBook(book.id, { active: !book.active }), book.active ? 'Unpublished' : 'Published')}>
              {book.active ? 'Unpublish' : 'Publish'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function fmtPrice(cents: number | null | undefined) {
  if (cents == null) return '—';
  return '$' + (cents / 100).toFixed(2);
}

function BookEditor({ book, grades, onClose, onSaved }: { book: any; grades: any[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(book.title as string);
  const [author, setAuthor] = useState((book.author ?? '') as string);
  const [description, setDescription] = useState((book.description ?? '') as string);
  const [subject, setSubject] = useState((book.subject ?? '') as string);
  const [price, setPrice] = useState(book.price_cents != null ? (book.price_cents / 100).toFixed(2) : '');
  const [gradeIds, setGradeIds] = useState<Set<string>>(new Set(book.grade_ids || []));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const toggleGrade = (id: string) => setGradeIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const save = async () => {
    if (!title.trim()) { setErr('Title required'); return; }
    const cents = price.trim() === '' ? null : Math.round(Number(price) * 100);
    if (cents != null && (Number.isNaN(cents) || cents < 0)) { setErr('Price must be a non-negative number'); return; }
    setBusy(true); setErr('');
    try {
      await api.patchBook(book.id, {
        title: title.trim(), author: author.trim() || null, description: description.trim() || null,
        subject: subject.trim() || null, price_cents: cents, grade_ids: gradeIds.size ? [...gradeIds] : null,
      });
      toast('Book updated'); onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={`Edit — ${book.title}`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={save}>Save</button></>}>
      <div className="row"><div className="grow"><label>Title</label><input value={title} onChange={e => setTitle(e.target.value)} /></div>
        <div className="grow"><label>Author</label><input value={author} onChange={e => setAuthor(e.target.value)} /></div></div>
      <div className="row"><div className="grow"><label>Subject</label><input value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. Verbal reasoning" /></div>
        <div className="grow"><label>Price (USD)</label><input value={price} onChange={e => setPrice(e.target.value)} placeholder="e.g. 12.99 (blank = not priced)" /></div></div>
      <label>Description</label><textarea rows={2} value={description} onChange={e => setDescription(e.target.value)} />
      <label style={{ marginTop: 8 }}>Grades (blank = all grades)</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {grades.map(g => <button key={g.id} type="button" className={`chipbtn ${gradeIds.has(g.id) ? 'on' : ''}`} onClick={() => toggleGrade(g.id)}>Grade {g.grade_number}</button>)}
      </div>
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}

function BookLinks({ book, platforms, manage, act }: { book: any; platforms: Platform[]; manage: boolean; act: (fn: Promise<any>, m: string) => void }) {
  const [add, setAdd] = useState(false);
  const links = (book.retailers || []) as any[];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="buylinks-h">Buy links</div>
      {links.length === 0 && <div className="muted" style={{ fontSize: 12.5, fontWeight: 700 }}>No buy links yet.</div>}
      {links.map(l => (
        <div key={l.id} className={`buylink ${l.active ? '' : 'off'}`}>
          <div className="blmid">
            <div><span className="blname">{l.retailer}</span>{l.kind && <span className="blkind"> · {l.kind}</span>}{!l.active && <span className="blkind"> · hidden</span>}</div>
            <a className="blurl" href={l.url} target="_blank" rel="noreferrer">{l.url}</a>
          </div>
          <a href={l.url} target="_blank" rel="noreferrer" aria-label={`Open ${l.retailer} link`} style={{ color: 'var(--muted)', fontWeight: 800 }}>↗</a>
          {/* BLUEPRINT-ADD: per-link hide/remove management controls (mockup shows only the link + arrow). */}
          {manage && <>
            <button className="btn ghost sm" style={{ padding: '4px 9px' }} onClick={() => act(api.patchBookLink(book.id, l.id, { active: !l.active }), l.active ? 'Link hidden' : 'Link shown')}>{l.active ? 'Hide' : 'Show'}</button>
            <button className="btn danger sm" style={{ padding: '4px 9px' }} onClick={() => act(api.deleteBookLink(book.id, l.id), 'Link removed')}>×</button>
          </>}
        </div>
      ))}
      {manage && (add
        ? <LinkForm platforms={platforms} onCancel={() => setAdd(false)} onSubmit={(retailer, url, kind) => { act(api.addBookLink(book.id, { retailer, url, kind: kind || undefined }), 'Link added'); setAdd(false); }} />
        : <button className="adddash" onClick={() => setAdd(true)}>+ Add buy link</button>)}
    </div>
  );
}

const LINK_KINDS = ['Paperback', 'Hardcover', 'eBook', 'Audiobook'];
function LinkForm({ platforms, onCancel, onSubmit }: { platforms: Platform[]; onCancel: () => void; onSubmit: (retailer: string, url: string, kind: string) => void }) {
  const [retailer, setRetailer] = useState(platforms[0]?.label || '');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState(LINK_KINDS[0]);
  const hint = platforms.find(p => p.label === retailer)?.domains.join(', ');
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
      <select value={retailer} onChange={e => setRetailer(e.target.value)} style={{ minWidth: 160 }}>
        {platforms.map(p => <option key={p.key} value={p.label}>{p.label}</option>)}
      </select>
      <select value={kind} onChange={e => setKind(e.target.value)} style={{ minWidth: 120 }} aria-label="Format">
        {LINK_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
      </select>
      <div style={{ flex: 1, minWidth: 220 }}>
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" style={{ width: '100%' }} />
        {hint && <div className="muted" style={{ fontSize: 12 }}>Allowed: {hint}</div>}
      </div>
      <button className="btn sm" disabled={!url.trim()} onClick={() => onSubmit(retailer, url.trim(), kind)}>Add</button>
      <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function BookCreate({ platforms, onClose, onSaved }: { platforms: Platform[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ title: '', author: '', description: '' });
  const [retailer, setRetailer] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!retailer && platforms[0]) setRetailer(platforms[0].label); }, [platforms]);
  const hint = platforms.find(p => p.label === retailer)?.domains.join(', ');
  const submit = async () => {
    if (!f.title.trim() || !retailer.trim() || !url.trim()) { setErr('Title, a retailer, and a URL are required'); return; }
    setBusy(true); setErr('');
    try {
      await api.createBook({ title: f.title.trim(), author: f.author.trim() || undefined, description: f.description.trim() || undefined, retailer, url: url.trim() });
      toast('Book added'); onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Add book" onClose={onClose} footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={submit}>Add book</button></>}>
      <label>Title</label><input value={f.title} onChange={e => setF({ ...f, title: e.target.value })} />
      <label>Author</label><input value={f.author} onChange={e => setF({ ...f, author: e.target.value })} />
      <label>Description</label><input value={f.description} onChange={e => setF({ ...f, description: e.target.value })} />
      <label>First buy link</label>
      <div className="row">
        <select value={retailer} onChange={e => setRetailer(e.target.value)} style={{ minWidth: 160 }}>
          {platforms.map(p => <option key={p.key} value={p.label}>{p.label}</option>)}
        </select>
        <div className="grow"><input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" /></div>
      </div>
      {hint && <div className="muted" style={{ fontSize: 12 }}>Allowed domains: {hint}</div>}
      <div className="err">{err}</div>
    </Modal>
  );
}
