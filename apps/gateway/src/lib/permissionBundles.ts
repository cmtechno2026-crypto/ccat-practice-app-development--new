// Permission bundles (Blueprint §23) — named presets of the fine-grained permission catalog so
// Super-Admins can provision a typical role in one click instead of ticking ~20 boxes. A bundle is
// a convenience grouping ONLY: the granted rows are still the individual permission keys (RBAC is
// enforced per-permission server-side), so an admin can start from a bundle and then fine-tune.
// Every key below must exist in ccat.permissions and be non-super_admin_only (SA powers are implicit
// for the super_admin role and are never granted à la carte). A test asserts this against the catalog.
export interface PermissionBundle { key: string; label: string; description: string; permissions: string[] }

export const PERMISSION_BUNDLES: PermissionBundle[] = [
  {
    key: 'support_agent', label: 'Support Agent',
    description: 'Front-line student support: directory, suspend/unsuspend, device revoke, goodwill reward adjustments, support-side deletion/export.',
    permissions: ['student.directory', 'student.suspend', 'student.unsuspend', 'device.revoke', 'reward.adjust', 'deletion.support', 'export.support'],
  },
  {
    key: 'content_editor', label: 'Content Editor',
    description: 'Authoring workflow: create, edit, review, publish, retire questions and manage learning plans.',
    permissions: ['content.create', 'content.edit', 'content.review', 'content.publish', 'content.retire', 'learning_plan.manage'],
  },
  {
    key: 'gamification_manager', label: 'Gamification Manager',
    description: 'Rewards surface: achievements, avatar families/stages, and themes.',
    permissions: ['achievement.manage', 'avatar.manage', 'theme.manage'],
  },
  {
    key: 'comms_manager', label: 'Communications Manager',
    description: 'Announcements (manage + publish), push campaign requests, and the Book Store.',
    permissions: ['announcement.manage', 'announcement.publish', 'push.request', 'book.manage'],
  },
  {
    key: 'health_viewer', label: 'Service Health Viewer',
    description: 'Read the health console, manage incidents, and export own audit trail.',
    permissions: ['health.view', 'incident.manage', 'audit.export.self'],
  },
];
