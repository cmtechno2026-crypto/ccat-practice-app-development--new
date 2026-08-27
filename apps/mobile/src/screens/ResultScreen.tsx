import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Screen, T, Card, Button, StatTile } from '../components/ui';
import { colors, spacing } from '../theme';
import { useApp } from '../lib/store';

export function ResultScreen() {
  const { params, navigate } = useApp();
  const r = params.result;
  if (!r) return <Screen center><Button title="Back home" onPress={() => navigate('home')} /></Screen>;
  const pct = r.score_total > 0 ? Math.round((100 * r.score_correct) / r.score_total) : 0;
  return (
    <Screen center>
      <View style={{ alignItems: 'center', marginBottom: spacing(3) }}>
        <View style={styles.ring}><T variant="h1" style={{ color: colors.primary, fontSize: 40 }}>{pct}%</T></View>
        <T variant="h2" style={{ marginTop: spacing(2) }}>{r.terminal_state === 'AUTO_SUBMITTED' ? 'Time’s up — submitted!' : 'Nice work!'}</T>
        <T variant="small">{r.score_correct} of {r.score_total} correct</T>
      </View>
      <View style={styles.stats}>
        <StatTile label="XP earned" value={`+${r.xp_awarded}`} tint={'#e7f6ef'} />
        <StatTile label="Coins" value={`+${r.coins_awarded}`} tint={'#fff0f1'} />
      </View>
      {(r.achievements_unlocked?.length ?? 0) > 0 && (
        <Card style={{ alignSelf: 'stretch', marginTop: spacing(2) }}>
          <T variant="small">🏆 New achievement{r.achievements_unlocked!.length > 1 ? 's' : ''}</T>
          {r.achievements_unlocked!.map((a) => (
            <T key={a.key} variant="bodyBold" style={{ marginTop: 2 }}>{a.name}</T>
          ))}
        </Card>
      )}
      <View style={{ height: spacing(3) }} />
      <Button title="Back to home" onPress={() => navigate('home')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  ring: { width: 160, height: 160, borderRadius: 80, borderWidth: 10, borderColor: colors.bgTintBlue, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white },
  stats: { flexDirection: 'row', alignSelf: 'stretch', marginHorizontal: -spacing(0.5) },
});
