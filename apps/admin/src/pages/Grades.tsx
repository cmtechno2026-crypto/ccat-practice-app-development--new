import React from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync, Panel, Loading, ErrorBox, useToast } from '../components/ui';

export function Grades() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api.grades());
  if (loading) return <Loading />;
  if (error) return <ErrorBox e={error} />;
  const editable = can('config.global');
  const toggle = async (id: string, field: string, value: boolean) => { try { await api.patchGrade(id, { [field]: value }); toast('Grade updated'); reload(); } catch (e) { toast((e as Error).message); } };
  return (
    <>
      <h2>Grades</h2>
      <p className="lead">Grade catalog is data-driven (§29). {editable ? 'Toggle registration/practice per grade.' : 'Read-only — needs Super-Admin.'}</p>
      <Panel>
        <div className="tablewrap"><table>
          <thead><tr><th>Grade</th><th>Students</th><th className="center">Active</th><th className="center">Registration</th><th className="center">Practice</th><th>Age bounds</th></tr></thead>
          <tbody>{data!.items.map((g: any) => (
            <tr key={g.id}><td style={{ fontWeight: 700 }}>{g.name}</td><td className="tabnum">{g.student_count}</td>
              <td className="center"><input type="checkbox" style={{ width: 'auto' }} checked={g.active} disabled={!editable} onChange={e => toggle(g.id, 'active', e.target.checked)} /></td>
              <td className="center"><input type="checkbox" style={{ width: 'auto' }} checked={g.registration_enabled} disabled={!editable} onChange={e => toggle(g.id, 'registration_enabled', e.target.checked)} /></td>
              <td className="center"><input type="checkbox" style={{ width: 'auto' }} checked={g.practice_enabled} disabled={!editable} onChange={e => toggle(g.id, 'practice_enabled', e.target.checked)} /></td>
              <td className="muted">{g.age_min_years ?? '—'}–{g.age_max_years ?? '—'}</td></tr>
          ))}</tbody>
        </table></div>
      </Panel>
    </>
  );
}
