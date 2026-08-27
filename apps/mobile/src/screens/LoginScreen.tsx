import React, { useState } from 'react';
import { View, TextInput, StyleSheet, TouchableOpacity } from 'react-native';
import { Screen, T, Button, Card } from '../components/ui';
import { colors, radius, spacing } from '../theme';
import { useApp } from '../lib/store';
import { client, getDeviceHash } from '../lib/api';
import { ApiError } from '@ccat/api-client';

export function LoginScreen() {
  const { navigate, setProfile } = useApp();
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onLogin() {
    setError(null); setLoading(true);
    try {
      const device = await getDeviceHash();
      await client.login(username.trim(), pin, device);
      setProfile(await client.profile());
      navigate('home');
    } catch (e) {
      setError(e instanceof ApiError ? errText(e) : 'Something went wrong');
    } finally { setLoading(false); }
  }

  return (
    <Screen>
      <T variant="h1">Welcome back</T>
      <T variant="small" style={{ marginBottom: spacing(2) }}>Log in on your enrolled device.</T>
      <Card>
        <T variant="bodyBold">Username</T>
        <TextInput style={styles.input} autoCapitalize="none" value={username} onChangeText={setUsername} placeholder="your username" placeholderTextColor={colors.muted} />
        <T variant="bodyBold" style={{ marginTop: spacing(1.5) }}>4-digit PIN</T>
        <TextInput style={styles.input} value={pin} onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" secureTextEntry maxLength={4} placeholder="••••" placeholderTextColor={colors.muted} />
      </Card>
      {error && <T style={{ color: colors.coral, marginBottom: spacing(1) }}>{error}</T>}
      <Button title="Log in" onPress={onLogin} loading={loading} disabled={username.length < 3 || pin.length !== 4} />
      <View style={styles.links}>
        <TouchableOpacity onPress={() => navigate('recovery')}><T variant="small" style={{ color: colors.primary }}>Forgot PIN?</T></TouchableOpacity>
        <TouchableOpacity onPress={() => navigate('deviceReplace')}><T variant="small" style={{ color: colors.primary }}>Use a new device</T></TouchableOpacity>
      </View>
      <View style={{ height: spacing(1) }} />
      <Button title="Back" variant="secondary" onPress={() => navigate('welcome')} />
    </Screen>
  );
}

function errText(e: ApiError): string {
  if (e.code === 'DEVICE_NOT_ENROLLED' || e.code === 'NO_ENROLLED_DEVICE') return 'This device isn’t enrolled. Ask a guardian to help move your account here.';
  if (e.code === 'RATE_LIMITED') return 'Too many tries. Please wait a bit and try again.';
  if (e.status === 401) return 'That username or PIN doesn’t match.';
  return e.message;
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: spacing(1.5), paddingVertical: spacing(1.25), marginTop: spacing(0.5), fontFamily: 'Nunito_400Regular', fontSize: 16, color: colors.ink },
  links: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing(1.5), paddingHorizontal: spacing(0.5) },
});
