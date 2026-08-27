import React from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync, Panel, Loading, ErrorBox, useToast } from '../components/ui';

const LABELS: Record<string, string> = {
  registration_enabled: 'New registrations', student_login_enabled: 'Student login', session_start_enabled: 'Starting sessions',
  device_replacement_enabled: 'Device replacement', content_publish_enabled: 'Content publishing',
  push_delivery_enabled: 'Push delivery', maintenance_mode: 'Maintenance mode',
  channel_web_enabled: 'Website (CCAT Practice web)', channel_app_enabled: 'Mobile app',
};
// Per-client channel enable flags — promoted to a first-class control (see /v1/channel-status).
const CHANNEL_KEYS = ['channel_web_enabled', 'channel_app_enabled'];
const CHANNEL_DESC: Record<string, string> = {
  channel_web_enabled: 'When off, the student website shows a clean "unavailable" state and loads no data.',
  channel_app_enabled: 'When off, the mobile app shows a clean "unavailable" state and loads no data.',
};
export function Flags() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api.flags());
  if (loading) return <Loading />;
  if (error) return <ErrorBox e={error} />;
  const editable = can('flags.emergency');
  const set = async (key: string, value: boolean) => { try { await api.setFlag(key, value, 'admin console'); toast(`${LABELS[key] || key} ${value ? 'on' : 'off'}`); reload(); } catch (e) { toast((e as Error).message); } };
  const items: any[] = data!.items;
  const channels = CHANNEL_KEYS.map(k => items.find(f => f.key === k)).filter(Boolean);
  const rest = items.filter(f => !CHANNEL_KEYS.includes(f.key));
  return (
    <>
      <h2>Feature Flags</h2>
      <p className="lead">Emergency global controls (§28). Availability flags apply immediately. {editable ? '' : 'Read-only — needs Super-Admin.'}</p>

      {channels.length > 0 && (
        <Panel title="Client channels">
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>Turn each client on or off without a redeploy. Clients read these live from <code>/v1/channel-status</code> and show a clean "unavailable" state when their channel is off.</p>
          <div className="chanrow">
            {channels.map((f: any) => (
              <div className="chancard" key={f.key}>
                <div className="chanhead">
                  <div>
                    <div className="chantitle">{LABELS[f.key] || f.key}</div>
                    <div className="chankey muted">{f.key}</div>
                  </div>
                  <span className={`pill ${f.value ? 's-active' : 's-Degraded'}`}>{f.value ? 'Live' : 'Off'}</span>
                </div>
                <p className="muted" style={{ fontSize: 12.5, margin: '2px 0 10px' }}>{CHANNEL_DESC[f.key]}</p>
                <label className="chantoggle">
                  <input type="checkbox" style={{ width: 'auto' }} checked={f.value} disabled={!editable} onChange={e => set(f.key, e.target.checked)} />
                  <span>{f.value ? 'Enabled' : 'Disabled'}</span>
                </label>
                {f.updated_at && <div className="muted tabnum" style={{ fontSize: 11.5, marginTop: 6 }}>Updated {new Date(f.updated_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel>
        <div className="tablewrap"><table>
          <thead><tr><th>Control</th><th>Key</th><th className="center">Enabled</th><th>Updated</th></tr></thead>
          <tbody>{rest.map((f: any) => (
            <tr key={f.key}><td style={{ fontWeight: 700 }}>{LABELS[f.key] || f.key}{f.key === 'maintenance_mode' && <span className="pill s-Degraded" style={{ marginLeft: 8 }}>caution</span>}</td>
              <td className="muted">{f.key}</td>
              <td className="center"><input type="checkbox" style={{ width: 'auto' }} checked={f.value} disabled={!editable} onChange={e => set(f.key, e.target.checked)} /></td>
              <td className="muted tabnum">{f.updated_at ? new Date(f.updated_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td></tr>
          ))}</tbody>
        </table></div>
      </Panel>
    </>
  );
}
