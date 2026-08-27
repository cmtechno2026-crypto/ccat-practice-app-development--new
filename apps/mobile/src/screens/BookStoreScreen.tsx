import React, { useEffect, useState } from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity, TextInput, Linking, Modal } from 'react-native';
import { Screen, T, Card, Button, Pill } from '../components/ui';
import { colors, radius, spacing } from '../theme';
import { useApp } from '../lib/store';
import { client } from '../lib/api';
import type { Book, AdultChallenge } from '@ccat/api-client';

// Book Store (Blueprint §21): info + external retailer links only. Tapping a retailer requires
// passing an adult challenge (no OTP); the server returns an allowlisted HTTPS destination that
// opens in the system browser. No embedded checkout, no premium language.
export function BookStoreScreen() {
  const { navigate } = useApp();
  const [books, setBooks] = useState<Book[]>([]);
  const [gate, setGate] = useState<{ book: Book; retailerId: string; challenge: AdultChallenge } | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { client.books().then(setBooks).catch(() => {}); }, []);

  async function openGate(book: Book, retailerId: string) {
    setError(null); setAnswer('');
    try { const challenge = await client.bookAdultChallenge(book.id); setGate({ book, retailerId, challenge }); }
    catch (e: any) { setError(e?.message ?? 'Error'); }
  }

  async function confirmGate() {
    if (!gate) return;
    setBusy(true); setError(null);
    try {
      const { destination_url } = await client.bookRetailerHandoff(gate.book.id, gate.challenge.challenge_token, answer.trim(), gate.retailerId);
      setGate(null);
      await Linking.openURL(destination_url);
    } catch (e: any) {
      setError(e?.code === 'ADULT_CHALLENGE_FAILED' ? 'That answer wasn’t right — please ask a grown-up.' : (e?.message ?? 'Error'));
    } finally { setBusy(false); }
  }

  return (
    <Screen>
      <View style={styles.header}>
        <T variant="h1">Book Store</T>
        <TouchableOpacity onPress={() => navigate('home')} accessibilityRole="button" accessibilityLabel="Back to home"><Pill label="Home" tint={colors.bgTintBlue} /></TouchableOpacity>
      </View>
      <T variant="small" style={{ marginBottom: spacing(1.5) }}>Great books to keep learning. Links open with a grown-up’s help.</T>
      <ScrollView showsVerticalScrollIndicator={false}>
        {books.map((b) => (
          <Card key={b.id}>
            <T variant="bodyBold">{b.title}</T>
            {b.author ? <T variant="small">by {b.author}</T> : null}
            {b.description ? <T variant="body" style={{ marginTop: spacing(0.5) }}>{b.description}</T> : null}
            <View style={styles.retailers}>
              {b.retailers.map((r) => (
                <TouchableOpacity key={r.id} onPress={() => openGate(b, r.id)} accessibilityRole="button" accessibilityLabel={`Open ${r.retailer} for ${b.title}`}>
                  <Pill label={`${r.retailer} ›`} tint={colors.bgTintLilac} />
                </TouchableOpacity>
              ))}
            </View>
          </Card>
        ))}
        {books.length === 0 && <Card><T variant="small">No books available yet.</T></Card>}
        {error && !gate && <T style={{ color: colors.coral }}>{error}</T>}
        <View style={{ height: spacing(3) }} />
      </ScrollView>

      <Modal visible={!!gate} transparent animationType="fade" onRequestClose={() => setGate(null)}>
        <View style={styles.modalBack}>
          <View style={styles.modal}>
            <T variant="h2">Grown-up check</T>
            <T variant="small" style={{ marginTop: 4 }}>To open an outside link, please solve:</T>
            <T variant="bodyBold" style={{ marginTop: spacing(1), fontSize: 20 }}>{gate?.challenge.prompt}</T>
            <TextInput style={styles.input} keyboardType="number-pad" value={answer} onChangeText={setAnswer} placeholder="answer" placeholderTextColor={colors.muted} accessibilityLabel="Adult challenge answer" />
            {error && gate && <T style={{ color: colors.coral, marginTop: spacing(0.5) }}>{error}</T>}
            <View style={{ flexDirection: 'row', gap: spacing(1.5), marginTop: spacing(1.5) }}>
              <View style={{ flex: 1 }}><Button title="Cancel" variant="secondary" onPress={() => setGate(null)} /></View>
              <View style={{ flex: 1 }}><Button title="Open link" onPress={confirmGate} loading={busy} disabled={answer.trim() === ''} /></View>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing(1) },
  retailers: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(1), marginTop: spacing(1.25) },
  modalBack: { flex: 1, backgroundColor: 'rgba(42,46,67,0.4)', justifyContent: 'center', padding: spacing(3) },
  modal: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing(3) },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: spacing(1.5), paddingVertical: spacing(1.25), marginTop: spacing(1), fontFamily: 'Nunito_400Regular', fontSize: 18, color: colors.ink },
});
