import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Screen, T, Card, Pill } from '../components/ui';
import { colors, radius, spacing } from '../theme';
import { useApp } from '../lib/store';
import { client } from '../lib/api';
import type { AvatarsResponse, Theme } from '@ccat/api-client';

export function CustomizeScreen() {
  const { navigate, refreshProfile } = useApp();
  const [avatars, setAvatars] = useState<AvatarsResponse | null>(null);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [a, t] = await Promise.allSettled([client.avatars(), client.themes()]);
    if (a.status === 'fulfilled') setAvatars(a.value);
    if (t.status === 'fulfilled') setThemes(t.value);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function equipAvatar(stageId: string, owned: boolean) {
    if (!owned) { setMsg('Earn more XP to unlock this one.'); return; }
    setMsg(null);
    try { await client.equipAvatar(stageId); await load(); await refreshProfile(); }
    catch (e: any) { setMsg(e?.message ?? 'Could not equip'); }
  }
  async function equipTheme(themeId: string, owned: boolean) {
    if (!owned) { setMsg('Earn more XP to unlock this theme.'); return; }
    setMsg(null);
    try { await client.equipTheme(themeId); await load(); await refreshProfile(); }
    catch (e: any) { setMsg(e?.message ?? 'Could not equip'); }
  }

  return (
    <Screen>
      <View style={styles.header}>
        <View>
          <T variant="h1">Customize</T>
          {avatars && <T variant="small">{avatars.xp_total} XP earned</T>}
        </View>
        <TouchableOpacity onPress={() => navigate('home')}><Pill label="Home" tint={colors.bgTintBlue} /></TouchableOpacity>
      </View>
      {msg && <T style={{ color: colors.inkSoft, marginBottom: spacing(1) }}>{msg}</T>}
      <ScrollView showsVerticalScrollIndicator={false}>
        <T variant="h2" style={{ marginBottom: spacing(1) }}>Avatars</T>
        {avatars?.families.map((fam) => (
          <View key={fam.family_id} style={{ marginBottom: spacing(1) }}>
            <T variant="small" style={{ marginBottom: spacing(0.5) }}>{fam.name}</T>
            <View style={styles.grid}>
              {fam.stages.map((s) => (
                <TouchableOpacity key={s.stage_id} onPress={() => equipAvatar(s.stage_id, s.owned)}
                  style={[styles.avatar, s.active && styles.avatarActive, !s.owned && styles.locked]}>
                  <T style={{ fontSize: 30 }}>{s.owned ? '🦊' : '🔒'}</T>
                  <T variant="small" style={{ textAlign: 'center' }}>{s.name}</T>
                  {!s.owned && s.required_xp != null && <T style={styles.req}>{s.required_xp} XP</T>}
                  {s.active && <Pill label="On" tint={'#e7f6ef'} />}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))}

        <T variant="h2" style={{ marginTop: spacing(2), marginBottom: spacing(1) }}>Themes</T>
        {themes.map((th) => (
          <TouchableOpacity key={th.id} onPress={() => equipTheme(th.id, th.owned)}>
            <Card style={[th.active && { borderColor: colors.primary, backgroundColor: colors.bgTintBlue }, !th.owned && { opacity: 0.6 }]}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <T variant="bodyBold">{th.name}</T>
                  <T variant="small">{th.owned ? 'Unlocked' : th.requirement}</T>
                </View>
                {th.active ? <Pill label="Active" tint={'#e7f6ef'} /> : th.owned ? <Pill label="Equip" tint={colors.bgTintBlue} /> : <T style={{ fontSize: 18 }}>🔒</T>}
              </View>
            </Card>
          </TouchableOpacity>
        ))}
        <View style={{ height: spacing(3) }} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing(2) },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(1) },
  avatar: { width: 92, alignItems: 'center', padding: spacing(1), borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.card, gap: 2 },
  avatarActive: { borderColor: colors.primary, backgroundColor: colors.bgTintBlue },
  locked: { opacity: 0.6 },
  req: { fontFamily: 'Nunito_700Bold', fontSize: 11, color: colors.muted },
  row: { flexDirection: 'row', alignItems: 'center' },
});
