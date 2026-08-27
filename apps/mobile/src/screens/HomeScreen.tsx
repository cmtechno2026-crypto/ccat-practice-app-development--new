import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity, RefreshControl } from 'react-native';
import { Screen, T, Card, StatTile, Pill, Button } from '../components/ui';
import { colors, radius, spacing } from '../theme';
import { useApp } from '../lib/store';
import { client } from '../lib/api';
import type { CatalogItem, RewardsSummary, Readiness, Progress, Announcement } from '@ccat/api-client';

export function HomeScreen() {
  const { profile, navigate, signOut } = useApp();
  const [rewards, setRewards] = useState<RewardsSummary | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [r, rd, pr, cat, ann] = await Promise.allSettled([
      client.rewardsSummary(), client.readiness(), client.progress(), client.catalog(), client.announcements(),
    ]);
    if (r.status === 'fulfilled') setRewards(r.value);
    if (rd.status === 'fulfilled') setReadiness(rd.value);
    if (pr.status === 'fulfilled') setProgress(pr.value);
    if (cat.status === 'fulfilled') setCatalog(cat.value);
    if (ann.status === 'fulfilled') setAnnouncements(ann.value);
  }, []);

  function annText(a: Announcement): string {
    const blocks = Array.isArray(a.body_blocks) ? a.body_blocks : [];
    return blocks.map((b: any) => (b?.type === 'text' || b?.type === 'rich_text' ? String(b.value ?? '') : '')).join(' ');
  }

  useEffect(() => { load(); }, [load]);

  async function onStart(item: CatalogItem) {
    const mode = item.allowed_modes.includes('practice') ? 'practice' : 'exam';
    const s = await client.sessionStart(item.set_version_id, mode, 'untimed');
    navigate('session', { sessionId: s.id });
  }

  const readinessLabel = readiness?.insufficient_data ? 'Keep practising' : `${readiness?.readiness_pct}%`;
  const progressLabel = progress?.progress_pct == null ? '—' : `${progress.progress_pct}%`;

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        <View style={styles.header}>
          <View>
            <T variant="small">Hi there,</T>
            <T variant="h1">{profile?.display_name ?? 'Learner'}</T>
          </View>
          <TouchableOpacity onPress={signOut}><Pill label="Sign out" tint={colors.bgTintLilac} /></TouchableOpacity>
        </View>

        {announcements.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing(1.5) }}>
            {announcements.map((a) => (
              <View key={a.id} style={styles.annCard} accessible accessibilityLabel={`Announcement: ${a.title}. ${annText(a)}`}>
                <T variant="small" style={{ color: colors.purple }}>📣 Announcement</T>
                <T variant="bodyBold" style={{ marginTop: 2 }}>{a.title}</T>
                <T variant="small" numberOfLines={2}>{annText(a)}</T>
              </View>
            ))}
          </ScrollView>
        )}

        <Card style={{ backgroundColor: colors.bgTintBlue, borderColor: colors.bgTintBlue }}>
          <T variant="small">Readiness</T>
          <T variant="h1" style={{ color: colors.primary }}>{readinessLabel}</T>
          <T variant="small">{readiness?.insufficient_data ? 'Answer more questions to unlock your Readiness score.' : readiness?.band ?? ''}</T>
        </Card>

        <View style={styles.stats}>
          <StatTile label="Progress" value={progressLabel} tint={colors.bgTintLilac} />
          <StatTile label="XP" value={String(rewards?.xp_total ?? 0)} tint={'#e7f6ef'} />
          <StatTile label="Coins" value={String(rewards?.coin_balance ?? 0)} tint={'#fff0f1'} />
        </View>

        <View style={styles.links}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => navigate('bookmarks')}>
            <Card style={{ marginBottom: 0 }}>
              <T style={{ fontSize: 22 }}>⭐</T>
              <T variant="bodyBold" style={{ marginTop: 4 }}>Bookmarks</T>
              <T variant="small">Saved questions</T>
            </Card>
          </TouchableOpacity>
          <View style={{ width: spacing(1.5) }} />
          <TouchableOpacity style={{ flex: 1 }} onPress={() => navigate('achievements')}>
            <Card style={{ marginBottom: 0 }}>
              <T style={{ fontSize: 22 }}>🏆</T>
              <T variant="bodyBold" style={{ marginTop: 4 }}>Achievements</T>
              <T variant="small">Badges & rewards</T>
            </Card>
          </TouchableOpacity>
        </View>

        <TouchableOpacity onPress={() => navigate('bookstore')} style={{ marginTop: spacing(1.5) }} accessibilityRole="button" accessibilityLabel="Book Store">
          <Card style={{ backgroundColor: '#e7f6ef', borderColor: '#e7f6ef', marginBottom: 0 }}>
            <View style={styles.setRow}>
              <T style={{ fontSize: 22 }}>📚</T>
              <View style={{ flex: 1, marginLeft: spacing(1.5) }}>
                <T variant="bodyBold">Book Store</T>
                <T variant="small">Great books to keep learning</T>
              </View>
              <T style={{ fontSize: 20, color: colors.muted }}>›</T>
            </View>
          </Card>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigate('customize')} style={{ marginTop: spacing(1.5) }} accessibilityRole="button" accessibilityLabel="Customize avatars and themes">
          <Card style={{ backgroundColor: colors.bgTintLilac, borderColor: colors.bgTintLilac, marginBottom: 0 }}>
            <View style={styles.setRow}>
              <T style={{ fontSize: 22 }}>🎨</T>
              <View style={{ flex: 1, marginLeft: spacing(1.5) }}>
                <T variant="bodyBold">Customize</T>
                <T variant="small">Unlock avatars & themes with XP</T>
              </View>
              <T style={{ fontSize: 20, color: colors.muted }}>›</T>
            </View>
          </Card>
        </TouchableOpacity>

        <T variant="h2" style={{ marginTop: spacing(2), marginBottom: spacing(1) }}>Practice sets</T>
        {catalog.length === 0 && <T variant="small">No sets available for your grade yet.</T>}
        {catalog.map((item) => (
          <TouchableOpacity key={item.set_version_id} onPress={() => onStart(item)}>
            <Card>
              <View style={styles.setRow}>
                <View style={{ flex: 1 }}>
                  <T variant="bodyBold">{item.name}</T>
                  <T variant="small">{item.subcategory} · {item.question_count} questions</T>
                </View>
                {item.difficulty && <Pill label={item.difficulty} tint={colors.bgTintBlue} />}
              </View>
            </Card>
          </TouchableOpacity>
        ))}
        <View style={{ height: spacing(4) }} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing(2) },
  stats: { flexDirection: 'row', marginTop: spacing(1.5), marginHorizontal: -spacing(0.5) },
  links: { flexDirection: 'row', marginTop: spacing(2) },
  setRow: { flexDirection: 'row', alignItems: 'center' },
  annCard: { width: 260, backgroundColor: colors.card, borderColor: colors.line, borderWidth: 1, borderRadius: radius.md, padding: spacing(1.75), marginRight: spacing(1.25) },
});
