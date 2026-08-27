import React, { useState } from 'react';
import { TextInput, StyleSheet, View } from 'react-native';
import { Screen, T, Button, Card, Pill } from '../components/ui';
import { colors, radius, spacing } from '../theme';
import { useApp } from '../lib/store';
import { client, getDeviceHash } from '../lib/api';

// Move the account to this device (Blueprint §5.2). Guardian OTP → old device revoked, this
// device becomes the sole enrolled device.
export function DeviceReplaceScreen() {
  const { navigate, setProfile } = useApp();
  const [step, setStep] = useState<'start' | 'verify'>('start');
  const [username, setUsername] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function start() {
    setError(null); setLoading(true);
    try {
      const device = await getDeviceHash();
      const r = await client.deviceReplacementStart(username.trim(), device, 'email');
      setChallengeId(r.challenge_id); setDevCode(r._dev_code); setStep('verify');
    } catch (e: any) { setError(e?.message ?? 'Error'); } finally { setLoading(false); }
  }
  async function verify() {
    setError(null); setLoading(true);
    try {
      await client.deviceReplacementVerify(challengeId!, code.trim());
      setProfile(await client.profile());
      navigate('home');
    } catch (e: any) { setError(e?.message ?? 'Error'); } finally { setLoading(false); }
  }

  return (
    <Screen>
      <T variant="h1">Use a new device</T>
      <Pill label="Guardian verification" tint={colors.bgTintLilac} />
      <T variant="small" style={{ marginTop: spacing(1) }}>Only one device can be signed in at a time. A guardian confirms the switch.</T>
      <View style={{ height: spacing(2) }} />
      {step === 'start' ? (
        <>
          <Card>
            <T variant="bodyBold">Your username</T>
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
          </Card>
          {error && <T style={{ color: colors.coral }}>{error}</T>}
          <Button title="Move to this device" onPress={verify} loading={loading} disabled={code.length < 4} />
        </>
      )}
      <View style={{ height: spacing(1.5) }} />
      <Button title="Back" variant="secondary" onPress={() => navigate('login')} />
    </Screen>
  );
}
const styles = StyleSheet.create({ input: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: spacing(1.5), paddingVertical: spacing(1.25), marginTop: spacing(0.5), fontFamily: 'Nunito_400Regular', fontSize: 16, color: colors.ink } });
