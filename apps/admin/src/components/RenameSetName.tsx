import React, { useState } from 'react';
import { api } from '../lib/api';

// Small inline "Rename set" control — a pencil next to a set name. Clicking it swaps the name for an
// editable field (Enter/✓ saves, Esc/✕ cancels). Validates non-empty (trimmed) and unique (case-
// insensitive) against `existingNames` — the lowercased names of the OTHER sets in the same subcategory +
// difficulty. Persists via PATCH /sets/:id (api.patchSet); on success calls onRenamed(newName), on failure
// keeps the old name and shows an inline error. `children` is the normal (non-editing) name display so the
// caller keeps its own styling / click-to-open behaviour.
export function RenameSetName({ setId, name, existingNames, onRenamed, children }: {
  setId: string; name: string; existingNames: Set<string>; onRenamed: (name: string) => void; children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const start = (e: React.MouseEvent) => { e.stopPropagation(); setVal(name); setErr(''); setEditing(true); };
  const cancel = () => { setEditing(false); setErr(''); };
  const save = async () => {
    const nm = val.trim();
    if (!nm) { setErr('Name required'); return; }
    if (nm === name.trim()) { setEditing(false); return; }
    if (existingNames.has(nm.toLowerCase())) { setErr('A set with this name already exists here'); return; }
    setBusy(true); setErr('');
    try { await api.patchSet(setId, { name: nm }); onRenamed(nm); setEditing(false); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {children ?? <span>{name}</span>}
        <button className="iconbtn" title="Rename set" aria-label="Rename set" onClick={start}>✏️</button>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
      <input autoFocus value={val} disabled={busy}
        onChange={e => { setVal(e.target.value); setErr(''); }}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}
        style={{ minWidth: 150, fontSize: 14, padding: '4px 8px' }} />
      <button className="iconbtn" title="Save" aria-label="Save name" disabled={busy} onClick={save}>✓</button>
      <button className="iconbtn" title="Cancel" aria-label="Cancel rename" disabled={busy} onClick={cancel}>✕</button>
      {err && <span className="err" style={{ fontSize: 12 }}>{err}</span>}
    </span>
  );
}
