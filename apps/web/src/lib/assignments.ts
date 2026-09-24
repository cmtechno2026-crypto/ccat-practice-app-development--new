import type { NavigateFunction } from 'react-router-dom';
import type { Assignment } from '@ccat/api-client';
import { client } from './api';

// Per-battery colour + tint for the assignment date stamp / dot (matches the Home progress rings).
const BATTERY_VIS: Record<string, { color: string; tint: string }> = {
  verbal: { color: '#3e7bee', tint: '#eaf0ff' },
  quantitative: { color: '#22c3a6', tint: '#e6f7f1' },
  non_verbal: { color: '#8b5cf6', tint: '#f3ecfb' },
  nonverbal: { color: '#8b5cf6', tint: '#f3ecfb' },
};
export function batteryVis(categoryKey: string): { color: string; tint: string } {
  return BATTERY_VIS[categoryKey] ?? { color: '#6b7280', tint: '#eef1f6' };
}

// "Verbal · Sentence Completion — Set 3" (exam papers have no sub-category → "Verbal · Exam — Paper 1").
export function assignmentTitle(a: Assignment): string {
  const sub = a.subcategory ?? (a.is_exam ? 'Exam' : '');
  const head = [a.category_name, sub].filter(Boolean).join(' · ');
  return a.name ? `${head} — ${a.name}` : head;
}

// Date stamp parts for the agenda rail, e.g. { day: "20", mon: "SEP" }.
export function assignDateStamp(iso: string): { day: string; mon: string } {
  const d = new Date(iso);
  return { day: String(d.getDate()), mon: d.toLocaleString('en', { month: 'short' }).toUpperCase() };
}

// Open an assigned set. In-progress → resume the existing session; assigned → start a fresh session
// (exam = timed with the paper's duration, practice = untimed); done → the caller decides (Review).
// On any error, fall back to the Practice list so the button is never a dead end.
export async function openAssignment(a: Assignment, nav: NavigateFunction, onError?: (msg: string) => void) {
  try {
    if (a.status === 'in_progress' && a.session_id) { nav(`/session/${a.session_id}`); return; }
    const isExam = a.is_exam;
    const durationSeconds = isExam ? Math.max(60, (a.duration_minutes ?? 30) * 60) : undefined;
    const session = await client.sessionStart(
      a.set_version_id,
      isExam ? 'exam' : 'practice',
      isExam ? 'timed' : 'untimed',
      durationSeconds,
    );
    nav(`/session/${session.id}`);
  } catch {
    onError?.('Could not open this set — try it from Practice.');
    nav('/practice');
  }
}
