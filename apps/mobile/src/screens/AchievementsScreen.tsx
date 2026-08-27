import React, { useEffect, useState } from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Screen, T, Card, Pill } from '../components/ui';
import { colors, radius, spacing } from '../theme';
import { useApp } from '../lib/store';
import { client } from '../lib/api';
import type { Achievement } from '@ccat/api-client';

export function AchievementsScreen() {
  const { navigate } = useApp();
  const [items, setItems] = useState<Achievement[]>([]);
  useEffect(() => { client.achievements().then(setItems).catch(() => {}); }, []);

  const earned = items.filter((a) => a.earned).length;

  function rewardLabel(a: Achievement): string {
    const parts = a.rewards.map((r) => (r.kind === 'xp' && r.xp ? `+${r.xp} XP` : r.kind === 'coins' && r.coins ? `+${r.coins} coins` : r.kind));
    return parts.join(' · ');
  }

  return (
    <Screen>
      <View style={styles.header}>
        <View>
          <T variant="h1">Achievements</T>
          <T variant="small">{earned} of {items.length} unlocked</T>
        </View>
        <TouchableOpacity onPress={() => navigate('home')}><Pill label="Home" tint={colors.bgTintBlue} /></TouchableOpacity>
      </View>
      <ScrollView showsVerticalScrollIndicator={false}>
        {items.map((a) => (
          <Card key={a.key} style={[!a.earned && { opacity: 0.65 }]}>
            <View style={styles.row}>
              <View style={[styles.medal, { backgroundColor: a.earned ? colors.amber : colors.line }]}>
                <T style={{ fontSize: 22 }}>{a.earned ? '🏆' : '🔒'}</T>
              </View>
              <View style={{ flex: 1 }}>
                <T variant="bodyBold">{a.name}</T>
                <T variant="small">{a.description}</T>
                {a.rewards.length > 0 && <T variant="small" style={{ color: colors.green, marginTop: 2 }}>{rewardLabel(a)}</T>}
              </View>
              {a.earned && <Pill label="Earned" tint={'#e7f6ef'} />}
            </View>
          </Card>
        ))}
        <View style={{ height: spacing(3) }} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing(2) },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing(1.5) },
  medal: { width: 46, height: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
});
