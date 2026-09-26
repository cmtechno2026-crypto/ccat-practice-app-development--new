import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

// TeacherHub site dashboard. Reads live counts from the TeacherHub backend via the gateway
// (X-Admin-Site: teacher). Renders a clear message when the Teacher DB isn't configured yet (503).
interface Summary { teachers: number; published_slots: number; open_slots: number; booked_slots: number; }

export function TeacherDashboard() {
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { let on = true; api.teacherSummary().then(d => on && setS(d)).catch(e => on && setErr(e.message || 'Failed to load')); return () => { on = false; }; }, []);

  const card = (label: string, n: number | string, sub: string, accent = 'var(--teal, #0f766e)') => (
    <div style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 14, padding: '16px 18px', position: 'relative', overflow: 'hidden' }}>
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: accent }} />
      <div className="muted" style={{ fontSize: 13, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1, margin: '4px 0 2px', fontVariantNumeric: 'tabular-nums' }}>{n}</div>
      <div className="muted" style={{ fontSize: 12 }}>{sub}</div>
    </div>
  );

  if (err) return <div className="empty" style={{ paddingTop: 40 }}>{err}</div>;
  if (!s) return <div className="empty" style={{ paddingTop: 40 }}>Loading…</div>;
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14 }}>
        {card('Active teachers', s.teachers, 'accounts on TeacherHub')}
        {card('Published slots', s.published_slots, 'this week')}
        {card('Open to parents', s.open_slots, 'visible availability')}
        {card('Booked', s.booked_slots, 'claimed slots', 'var(--coral,#e0533d)')}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>Live from the TeacherHub backend (ta_slots · ta_teachers).</div>
    </div>
  );
}
