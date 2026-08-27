import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Panel, StatusPill, Loading, ErrorBox } from '../components/ui';

const rel = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const humanInterval = (ms: number) => ms >= 3600000 ? `${ms / 3600000}h` : ms >= 60000 ? `${ms / 60000}m` : `${ms / 1000}s`;

// One SLO card: big value + a truthful progress bar (value shown against its scale — NOT a fake
// historical sparkline, which we don't have the data for).
function Slo({ label, value, unit, detail, good }: { label: string; value: number | null; unit?: string; detail?: string; good?: boolean }) {
  const pct = value == null ? 0 : unit === 'ms' ? Math.max(4, 100 - Math.min(100, value / 12)) : Math.min(100, value);
  const col = good === false ? 'var(--amber)' : 'var(--green)';
  return (
    <div className="panel" style={{ margin: 0 }}>
      <div className="muted" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontFamily: 'Baloo 2', fontSize: 26, color: 'var(--ink)', margin: '4px 0' }}>{value == null ? '—' : `${value}${unit || ''}`}</div>
      <div className="rbar" style={{ width: '100%' }}><i style={{ width: `${pct}%`, background: col }} /></div>
      {detail && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{detail}</div>}
    </div>
  );
}

export function Health() {
  const [health, setHealth] = useState<any>(null);
  const [jobs, setJobs] = useState<any[] | null>(null);
  const [infra, setInfra] = useState<any | null>(null);
  const [providers, setProviders] = useState<any[] | null>(null);
  const [error, setError] = useState<any>(null);
  const [opsDenied, setOpsDenied] = useState(false);

  const load = () => {
    setError(null);
    api.health().then(setHealth).catch(setError);
    Promise.all([api.opsJobs(), api.opsInfrastructure(), api.opsProviders()])
      .then(([j, i, p]) => { setJobs(j.jobs); setInfra(i); setProviders(p.providers); })
      .catch((e) => { if (e?.status === 403) setOpsDenied(true); });
  };
  useEffect(() => { load(); }, []);

  if (error) return <><h2>Service health</h2><ErrorBox e={error} /></>;
  if (!health) return <Loading />;

  const ind = (k: string) => health.indicators.find((i: any) => i.indicator === k);
  const sessions = ind('session_submit'); const login = ind('login_success'); const prov = ind('provider_health'); const latency = ind('latency_p95');
  const recon = ind('reward_reconciliation');
  const infraCards = infra ? [
    { title: 'Automated backups', c: infra.backup },
    { title: 'Disaster recovery', c: infra.disaster_recovery },
    { title: 'Database failover', c: infra.failover },
  ] : [];

  return (
    <>
      <div className="toolbar">
        <div>
          <h2 style={{ fontSize: 22 }}>Service health</h2>
          <p className="lead" style={{ marginBottom: 0 }}>Live SLOs, providers, scheduled jobs and integrity checks — aggregated product health, not a raw log viewer (§27).</p>
        </div>
        <div className="row" style={{ margin: 0, gap: 8, alignItems: 'center' }}>
          <StatusPill status={health.overall} />
          <button className="btn ghost sm" onClick={load}>Refresh</button>
        </div>
      </div>

      <div className="kpirow" style={{ marginBottom: 16 }}>
        <Slo label="Session submit" value={sessions?.value ?? null} unit="%" detail={sessions?.detail} good={sessions?.state === 'Healthy'} />
        <Slo label="Login success" value={login?.value ?? null} unit="%" detail="last 24h" good={(login?.value ?? 100) >= 99} />
        <Slo label="Provider health" value={prov?.value ?? null} unit="%" detail="external OTP / push" good={(prov?.value ?? 100) >= 95} />
        <Slo label="Latency p95" value={latency?.value ?? null} unit="ms" detail="gateway, in-request" good={(latency?.value ?? 0) < 500} />
      </div>

      <div className="contentgrid" style={{ gridTemplateColumns: '1fr 360px' }}>
        <div>
          <Panel title="Third-party providers">
            {opsDenied ? <div className="empty">Requires the health.view permission.</div> : providers === null ? <Loading /> : (
              <div className="tablewrap"><table>
                <thead><tr><th>Provider</th><th>Kind</th><th>State</th><th>Notes</th></tr></thead>
                <tbody>{providers.map((p: any) => (
                  <tr key={p.name}>
                    <td style={{ fontWeight: 700 }}>{p.name}</td>
                    <td className="muted">{p.kind}</td>
                    <td><span className={`pill ${p.configured ? 's-published' : 's-draft'}`} style={{ textTransform: 'none' }}>{p.state}</span></td>
                    <td className="muted" style={{ fontSize: 12.5 }}>{p.detail}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Panel>

          <Panel title="Scheduled jobs">
            {opsDenied ? <div className="empty">Requires the health.view permission.</div> : jobs === null ? <Loading /> : (
              <div className="tablewrap"><table>
                <thead><tr><th>Job</th><th>Every</th><th>Last run</th><th>Status</th><th className="right">Runs</th><th>Prod</th></tr></thead>
                <tbody>{jobs.map((j: any) => (
                  <tr key={j.key}>
                    <td><div style={{ fontWeight: 700 }}>{j.name}</div><div className="muted" style={{ fontSize: 12 }}>{j.description}</div></td>
                    <td className="muted tabnum">{humanInterval(j.interval_ms)}</td>
                    <td className="tabnum">{rel(j.last_run_at)}{j.stale && <span className="muted"> · stale</span>}</td>
                    <td><StatusPill status={j.last_status === 'ok' ? 'Healthy' : j.last_status === 'error' ? 'Major Incident' : 'Unknown'} /></td>
                    <td className="right tabnum">{j.runs_total}</td>
                    <td className="muted">{j.pg_cron_in_prod ? 'pg_cron' : 'worker'}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Panel>
        </div>

        <div>
          <div className="panel darkpanel">
            <div className="panelhead"><h3 style={{ color: '#fff' }}>Economy integrity</h3></div>
            <IntegrityRow label="Reward reconciliation" value={recon?.value === 0 ? 'In balance' : `${recon?.value ?? '—'} mismatches`} good={recon?.value === 0} />
            <IntegrityRow label="Session submit" value={sessions ? `${sessions.value ?? '—'}%` : '—'} good={sessions?.state === 'Healthy'} />
            <IntegrityRow label="Database" value={ind('database')?.state || '—'} good={ind('database')?.state === 'Healthy'} />
          </div>

          <Panel title="Backups & disaster recovery">
            {opsDenied ? <div className="empty">Requires the health.view permission.</div> : infra === null ? <Loading /> : (
              <div style={{ display: 'grid', gap: 10 }}>
                {infraCards.map(({ title, c }) => (
                  <div key={title} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingBottom: 8, borderBottom: '1px solid var(--line)' }}>
                    <div><div style={{ fontWeight: 700, fontSize: 13.5 }}>{title}</div></div>
                    <span className="pill dotted" style={{ textTransform: 'none' }}>{c.configured ? c.state : 'Not configured'}</span>
                  </div>
                ))}
                <p className="muted" style={{ fontSize: 12, margin: 0 }}>Managed-infrastructure concerns — no in-app trigger is shown because this environment has no backup pipeline or failover orchestrator. Wired via <code>OPS_PROVIDER</code> in production.</p>
              </div>
            )}
          </Panel>
        </div>
      </div>

      <Panel title="Open incidents">
        {health.incidents.length === 0 ? <div className="empty">No incidents recorded.</div> : (
          <div className="tablewrap"><table>
            <thead><tr><th>Title</th><th>Severity</th><th>State</th><th>Opened</th></tr></thead>
            <tbody>{health.incidents.map((i: any) => (
              <tr key={i.id}><td style={{ fontWeight: 700 }}>{i.title}</td><td>{i.severity}</td><td><StatusPill status={i.state} /></td>
                <td className="muted tabnum">{new Date(i.opened_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}

function IntegrityRow({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0' }}>
      <span style={{ color: 'rgba(255,255,255,.85)', fontSize: 13.5 }}>● {label}</span>
      <span style={{ color: good ? 'var(--green)' : 'var(--amber)', fontWeight: 700, fontSize: 13.5 }}>{value}</span>
    </div>
  );
}
