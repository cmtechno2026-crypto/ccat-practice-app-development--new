import React, { useState } from 'react';
import { TextInput, StyleSheet, View } from 'react-native';
import { Screen, T, Button, Card, Pill } from '../components/ui';
import { colors, radius, spacing } from '../theme';
import { useApp } from '../lib/store';
import { client } from '../lib/api';

// PIN recovery (Blueprint §4.4): guardian OTP → new PIN → fresh login required.
export function RecoveryScreen() {
  const { navigate } = useApp();
  const [step, setStep] = useState<'start' | 'complete'>('start');
  const [username, setUsername] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function start() {
    setError(null); setLoading(true);
    try { const r = await client.pinResetStart(username.trim(), 'email'); setChallengeId(r.challenge_id); setDevCode(r._dev_code); setStep('complete'); }
    catch (e: any) { setError(e?.message ?? 'Error'); } finally { setLoading(false); }
  }
  async function complete() {
    setError(null); setLoading(true);
    try { await client.pinResetComplete(challengeId!, code.trim(), pin); setDone(true); }
    catch (e: any) { setError(e?.message ?? 'Error'); } finally { setLoading(false); }
  }

  return (
    <Screen>
      <T variant="h1">Reset PIN</T>
      <Pill label="Guardian verification" tint={colors.bgTintLilac} />
      <View style={{ height: spacing(2) }} />
      {done ? (
        <>
          <Card><T variant="bodyBold">PIN updated ✓</T><T variant="small">Please log in with your new PIN.</T></Card>
          <Button title="Go to login" onPress={() => navigate('login')} />
        </>
      ) : step === 'start' ? (
        <>
          <Card>
            <T variant="bodyBold">Your username</T>
            <T variant="small">We’ll send a one-time code to the guardian on file.</T>
            <TextInput style={styles.input} autoCapitalize="none" value={username} onChangeText={setUsername} placeholder="username" placeholderTextColor={colors.muted} />
          </Card>
          {error && <T style={{ color: colors.coral }}>{error}</T>}
          <Button title="Send code" onPress={start} loading={loading} disabled={username.length < 3} />
        </>
      ) : (
        <>
          <Card>
            {devCode && <T style={{ color: colors.amber }}>Dev code: {devCode}</T>}
            <T variant="bodyBold" style={{ marginTop: spacing(1) }}>Code</T>
            <TextInput style={styles.input} keyboardType="number-pad" value={code} onChangeText={setCode} placeholder="6-digit code" placeholderTextColor={colors.muted} />
            <T variant="bodyBold" style={{ marginTop: spacing(1.5) }}>New 4-digit PIN</T>
            <TextInput style={styles.input} keyboardType="number-pad" secureTextEntry maxLength={4} value={pin} onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))} placeholder="••••" placeholderTextColor={colors.muted} />
          </Card>
          {error && <T style={{ color: colors.coral }}>{error}</T>}
          <Button title="Reset PIN" onPress={complete} loading={loading} disabled={code.length < 4 || pin.length !== 4} />
        </>
      )}
      <View style={{ height: spacing(1.5) }} />
      <Button title="Back" variant="secondary" onPress={() => navigate('login')} />
    </Screen>
  );
}
const styles = StyleSheet.create({ input: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: spacing(1.5), paddingVertical: spacing(1.25), marginTop: spacing(0.5), fontFamily: 'Nunito_400Regular', fontSize: 16, color: colors.ink } });
