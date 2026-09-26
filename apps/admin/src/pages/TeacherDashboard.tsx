import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

// TeacherHub site dashboard (Sample B). Live counts from the TeacherHub backend via the gateway
// (X-Admin-Site: teacher). A compact stat strip, an attention-first left column, and a
// this-week + recent-requests right column. Renders a clear message when the DB isn't configured (503).
interface Summary {
  teachers: number; published_slots: number; open_slots: number; booked_slots: number;
  pending_requests: number; ready_to_book: number; pending_leave: number;
  active_links: number; expired_links: number;
  requests_this_week: number; booked_this_week: number; new_teachers_week: number;
}
interface RecentReq {
  id: string; parent_name: string; student_name: string | null; status: string; teacher_status: string;
  created_at: string; slots: { teacher_name: string }[];
}

const card: React.CSSProperties = { background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 };
const h3: React.CSSProperties = { margin: '0 0 12px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 };
const moreLink: React.CSSProperties = { marginLeft: 'auto', fontSize: 12, color: 'var(--brand,#2f6fd0)', fontWeight: 700, textDecoration: 'none' };

function timeAgo(iso: string) {
  const d = Date.now() - new Date(iso).getTime();
  const h = Math.floor(d / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(d / 60000))}m ago`;
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}
function reqChip(r: RecentReq) {
  if (r.status === 'approved' || r.status === 'partially_approved') return ['Booked', 'var(--good-soft,#dcf5ea)', 'var(--good,#0f9d6b)'];
  if (r.status === 'rejected') return ['Rejected', 'var(--coral-soft,#fdecea)', 'var(--coral,#c0392b)'];
  if (r.teacher_status === 'declined') return ['Declined', 'var(--coral-soft,#fdecea)', 'var(--coral,#c0392b)'];
  if (r.teacher_status === 'accepted') return ['Ready', 'var(--brand-soft,#e7f0fc)', 'var(--brand,#2f6fd0)'];
  return ['Pending', '#fbf0d5', 'var(--amber,#b8860b)'];
}
function initials(n: string) {
  const letters = String(n || '').split(/\s+/).map(w => (w.match(/[A-Za-z]/) || [''])[0]).filter(Boolean);
  if (letters.length >= 2) return (letters[0] + letters[1]).toUpperCase();
  if (letters.length === 1) return letters[0].toUpperCase();
  return '?';
}

export function TeacherDashboard() {
  const [s, setS] = useState<Summary | null>(null);
  const [recent, setRecent] = useState<RecentReq[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    let on = true;
    api.teacherSummary().then(d => on && setS(d)).catch(e => on && setErr(e.message || 'Failed to load'));
    api.teacherBookingRequests({ status: 'all' }).then(d => on && setRecent((d.requests || []).slice(0, 4) as RecentReq[])).catch(() => {});
    return () => { on = false; };
  }, []);

  const stat = (label: string, n: number, accent: string) => (
    <div style={{ ...card, borderTop: `3px solid ${accent}`, padding: '13px 16px' }}>
      <div className="muted" style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{n}</div>
    </div>
  );
  const tile = (to: string, n: number, label: string, cta: string, hot: boolean) => (
    <Link to={to} style={{ display: 'flex', gap: 12, alignItems: 'center', border: '1px solid var(--line,#e6e6ef)', borderRadius: 10, padding: 12, textDecoration: 'none', color: 'inherit', background: hot ? '#fbf0d5' : 'var(--card2,#f7f9fc)', borderColor: hot ? '#f0dca0' : 'var(--line,#e6e6ef)' }}>
      <span style={{ fontSize: 24, fontWeight: 800, minWidth: 40, textAlign: 'center' }}>{n}</span>
      <span><span style={{ fontSize: 12.5, color: 'var(--muted,#647089)', fontWeight: 600 }}>{label}</span><br /><span style={{ fontSize: 11.5, color: hot ? 'var(--brand,#2f6fd0)' : 'var(--muted,#647089)', fontWeight: 700 }}>{cta}</span></span>
    </Link>
  );
  const weekTile = (n: number, label: string) => (
    <div style={{ flex: 1, minWidth: 96, border: '1px solid var(--line,#e6e6ef)', borderRadius: 10, padding: 12, background: 'var(--card2,#f7f9fc)' }}>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{n}</div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
    </div>
  );

  if (err) return <div className="empty" style={{ paddingTop: 40 }}>{err}</div>;
  if (!s) return <div className="empty" style={{ paddingTop: 40 }}>Loading…</div>;
  const cap = s.open_slots + s.booked_slots;
  const openPct = cap ? Math.round((s.open_slots / cap) * 100) : 0;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* stat strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
        {stat('Teachers', s.teachers, 'var(--brand,#2f6fd0)')}
        {stat('Published', s.published_slots, 'var(--teal,#0f766e)')}
        {stat('Open', s.open_slots, 'var(--good,#0f9d6b)')}
        {stat('Booked', s.booked_slots, 'var(--coral,#c0392b)')}
      </div>

      {/* two columns */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 14, alignItems: 'start' }}>
        {/* left: attention */}
        <section style={card}>
          <h3 style={h3}>⚡ Needs your attention</h3>
          <div style={{ display: 'grid', gap: 10 }}>
            {tile('/teacherhub/requests', s.pending_requests, 'Pending parent requests', s.pending_requests ? 'Review →' : 'All clear', s.pending_requests > 0)}
            {tile('/teacherhub/requests', s.ready_to_book, 'Ready to book (teacher accepted)', s.ready_to_book ? 'Book now →' : 'Nothing waiting', s.ready_to_book > 0)}
            {tile('/teacherhub/requests', s.pending_leave, 'Pending leave requests', s.pending_leave ? 'Review →' : 'All clear', s.pending_leave > 0)}
          </div>
          <div style={{ marginTop: 14 }}>
            <div className="muted" style={{ fontWeight: 700, marginBottom: 6, fontSize: 12.5 }}>Booking capacity</div>
            <div style={{ height: 8, borderRadius: 6, background: 'var(--card2,#f7f9fc)', overflow: 'hidden', display: 'flex' }}>
              <i style={{ display: 'block', height: '100%', width: `${openPct}%`, background: 'var(--good,#0f9d6b)' }} />
              <i style={{ display: 'block', height: '100%', width: `${100 - openPct}%`, background: 'var(--brand,#2f6fd0)' }} />
            </div>
            <div className="muted" style={{ marginTop: 6, fontSize: 12, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--good,#0f9d6b)' }} />{s.open_slots} open</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--brand,#2f6fd0)' }} />{s.booked_slots} booked</span>
              <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{openPct}% available</span>
            </div>
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link to="/teacherhub/booking-links" style={{ ...moreLink, marginLeft: 0, border: '1px solid var(--line,#e6e6ef)', borderRadius: 8, padding: '7px 12px' }}>🔗 Booking links · {s.active_links} active{s.expired_links ? ` · ${s.expired_links} expired` : ''}</Link>
            <Link to="/teacherhub/teachers" style={{ ...moreLink, marginLeft: 0, border: '1px solid var(--line,#e6e6ef)', borderRadius: 8, padding: '7px 12px' }}>👩‍🏫 Teachers</Link>
          </div>
        </section>

        {/* right: this week + recent */}
        <div style={{ display: 'grid', gap: 14 }}>
          <section style={card}>
            <h3 style={h3}>📅 This week</h3>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {weekTile(s.requests_this_week, 'New requests')}
              {weekTile(s.booked_this_week, 'Newly booked')}
              {weekTile(s.new_teachers_week, 'New teachers')}
            </div>
          </section>
          <section style={card}>
            <h3 style={h3}>🕑 Recent requests <Link to="/teacherhub/requests" style={moreLink}>View all →</Link></h3>
            {recent.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>No requests yet.</div> : (
              <div>
                {recent.map(r => { const [lab, bg, c] = reqChip(r); const t = [...new Set((r.slots || []).map(x => x.teacher_name).filter(Boolean))][0] || 'Teacher'; return (
                  <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--line,#eef1f6)' }}>
                    <span style={{ width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 11, flex: 'none', background: 'linear-gradient(135deg,#2f6fd0,#1e4e9e)' }}>{initials(r.parent_name)}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{r.parent_name}{r.student_name ? <span className="muted" style={{ fontWeight: 600 }}> · {r.student_name}</span> : null}</div>
                      <div className="muted" style={{ fontSize: 11.5 }}>{t} · {timeAgo(r.created_at)}</div>
                    </div>
                    <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', padding: '2px 7px', borderRadius: 999, background: bg, color: c }}>{lab}</span>
                  </div>
                ); })}
              </div>
            )}
          </section>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>Live from the TeacherHub backend (ta_slots · ta_teachers · ta_booking_requests).</div>
    </div>
  );
}
