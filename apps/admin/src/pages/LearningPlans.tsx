import React from 'react';
import { api } from '../lib/api';
import { useAsync, Panel, StatusPill, Loading, ErrorBox } from '../components/ui';

export function LearningPlans() {
  const { data, loading, error } = useAsync(() => api.learningPlans());
  if (loading) return <Loading />;
  if (error) return <ErrorBox e={error} />;
  return (
    <>
      <h2>Learning Plans</h2>
      <p className="lead">Versioned learning-plan coverage drives student Progress (§15). Content changes create a new plan version.</p>
      <Panel>
        <div className="tablewrap"><table>
          <thead><tr><th>Plan</th><th>Grade</th><th>Version</th><th>Eligible sets</th><th>Active</th></tr></thead>
          <tbody>{data!.items.map((p: any) => (
            <tr key={p.version_id}><td style={{ fontWeight: 700 }}>{p.name}</td><td>Grade {p.grade_number}</td><td className="tabnum">v{p.version_number}</td>
              <td className="tabnum">{p.set_count}</td><td>{p.is_active ? <StatusPill status="active" /> : <span className="muted">inactive</span>}</td></tr>
          ))}</tbody>
        </table></div>
        {data!.items.length === 0 && <div className="empty">No learning plans yet.</div>}
      </Panel>
    </>
  );
}
