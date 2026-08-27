import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity, RefreshControl } from 'react-native';
import { Screen, T, Card, Button, Pill } from '../components/ui';
import { colors, spacing } from '../theme';
import { useApp } from '../lib/store';
import { client } from '../lib/api';
import type { Bookmark } from '@ccat/api-client';

export function BookmarksScreen() {
  const { navigate } = useApp();
  const [items, setItems] = useState<Bookmark[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try { setItems(await client.bookmarks()); } finally { setLoaded(true); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function remove(id: string) {
    setItems((prev) => prev.filter((b) => b.logical_question_id !== id));
    try { await client.removeBookmark(id); } catch { load(); }
  }

  return (
    <Screen>
      <View style={styles.header}>
        <T variant="h1">Bookmarks</T>
        <TouchableOpacity onPress={() => navigate('home')}><Pill label="Home" tint={colors.bgTintBlue} /></TouchableOpacity>
      </View>
      <ScrollView showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        {loaded && items.length === 0 && (
          <Card><T variant="bodyBold">No bookmarks yet</T><T variant="small">Tap the star on any question to save it for later.</T></Card>
        )}
        {items.map((b) => (
          <Card key={b.logical_question_id}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Pill label={b.subcategory} tint={colors.bgTintLilac} />
                <T variant="bodyBold" style={{ marginTop: spacing(0.75) }}>{b.preview || 'Saved question'}</T>
                {b.note ? <T variant="small" style={{ marginTop: 2 }}>Note: {b.note}</T> : null}
              </View>
              <TouchableOpacity onPress={() => remove(b.logical_question_id)} style={{ paddingLeft: spacing(1.5) }}>
                <T style={{ fontSize: 22, color: colors.amber }}>★</T>
              </TouchableOpacity>
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
  row: { flexDirection: 'row', alignItems: 'flex-start' },
});
