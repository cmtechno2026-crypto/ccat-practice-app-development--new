import React, { useEffect, useMemo, useState } from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Screen, T, Card, Button, Pill } from '../components/ui';
import { colors, radius, spacing } from '../theme';
import { useApp } from '../lib/store';
import { client } from '../lib/api';
import type { SessionWithQuestions } from '@ccat/api-client';

// Renders a session and lets the child answer + submit. Prompt/option blocks are rendered
// for the launch block types (text/rich_text/math/image → text fallback here).
function renderBlocksText(blocks: unknown[]): string {
  return (blocks as any[]).map((b) => (b?.type === 'text' || b?.type === 'rich_text' ? b.value : b?.type === 'math' ? b.value : '[media]')).join(' ');
}

export function SessionScreen() {
  const { params, navigate } = useApp();
  const sessionId = params.sessionId!;
  const [session, setSession] = useState<SessionWithQuestions | null>(null);
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookmarked, setBookmarked] = useState<Record<string, boolean>>({});

  useEffect(() => { client.getSession(sessionId).then((s) => {
    setSession(s);
    const sel: Record<string, string[]> = {}; const ver: Record<string, number> = {};
    for (const q of s.questions) { sel[q.question_version_id] = q.selected_option_ids; ver[q.question_version_id] = q.answer_version; }
    setSelected(sel); setVersions(ver);
  }).catch((e) => setError(e.message)); }, [sessionId]);

  const q = session?.questions[idx];

  async function choose(optionId: string) {
    if (!q) return;
    const next = [optionId]; // single-select launch behavior
    setSelected({ ...selected, [q.question_version_id]: next });
    const nextVer = (versions[q.question_version_id] ?? 0) + 1;
    setVersions({ ...versions, [q.question_version_id]: nextVer });
    try {
      await client.saveAnswers(sessionId, [{ question_version_id: q.question_version_id, selected_option_ids: next, answer_version: nextVer }]);
    } catch { /* autosave is best-effort; final submit re-sends */ }
  }

  async function toggleBookmark() {
    if (!q) return;
    const lq = q.logical_question_id;
    const next = !bookmarked[lq];
    setBookmarked({ ...bookmarked, [lq]: next });
    try {
      if (next) await client.addBookmark(lq);
      else await client.removeBookmark(lq);
    } catch { setBookmarked({ ...bookmarked, [lq]: !next }); }
  }

  async function onSubmit() {
    if (!session) return;
    setSubmitting(true); setError(null);
    try {
      const result = await client.submit(sessionId, `sub_${sessionId}`, session.session_version);
      navigate('result', { result });
    } catch (e: any) {
      setError(e?.message ?? 'Could not submit');
    } finally { setSubmitting(false); }
  }

  if (error) return <Screen center><T style={{ color: colors.coral }}>{error}</T><View style={{ height: spacing(2) }} /><Button title="Back home" onPress={() => navigate('home')} /></Screen>;
  if (!session || !q) return <Screen center><T>Loading…</T></Screen>;

  const total = session.questions.length;
  const chosen = selected[q.question_version_id] ?? [];
  const isLast = idx === total - 1;

  return (
    <Screen>
      <View style={styles.top}>
        <Pill label={`${session.mode === 'exam' ? 'Exam' : 'Practice'}`} tint={colors.bgTintLilac} />
        <T variant="small">Question {idx + 1} of {total}</T>
      </View>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Card>
          <View style={styles.qhead}>
            <T variant="h2" style={{ flex: 1 }}>{renderBlocksText(q.prompt_blocks)}</T>
            <TouchableOpacity onPress={toggleBookmark} style={{ paddingLeft: spacing(1) }}>
              <T style={{ fontSize: 24, color: bookmarked[q.logical_question_id] ? colors.amber : colors.muted }}>
                {bookmarked[q.logical_question_id] ? '★' : '☆'}
              </T>
            </TouchableOpacity>
          </View>
        </Card>
        {q.option_blocks.map((o) => {
          const on = chosen.includes(o.option_id);
          return (
            <TouchableOpacity key={o.option_id} onPress={() => choose(o.option_id)}>
              <Card style={[styles.option, on && styles.optionOn]}>
                <T style={[{ fontFamily: 'Nunito_700Bold' }, on && { color: colors.primary }]}>{renderBlocksText(o.content)}</T>
              </Card>
            </TouchableOpacity>
          );
        })}
        <View style={{ height: spacing(2) }} />
        {!isLast
          ? <Button title="Next" onPress={() => setIdx(idx + 1)} disabled={chosen.length === 0} />
          : <Button title="Submit" onPress={onSubmit} loading={submitting} disabled={chosen.length === 0} />}
        <View style={{ height: spacing(1.5) }} />
        <Button title="Exit" variant="secondary" onPress={async () => { try { await client.abandon(sessionId, session.mode === 'exam'); } catch {} navigate('home'); }} />
        <View style={{ height: spacing(4) }} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing(1.5) },
  qhead: { flexDirection: 'row', alignItems: 'flex-start' },
  option: { borderColor: colors.line },
  optionOn: { borderColor: colors.primary, backgroundColor: colors.bgTintBlue },
});
