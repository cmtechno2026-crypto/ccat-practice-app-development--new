import React, { useEffect, useState } from 'react';
import { View, TextInput, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { Screen, T, Button, Card, Pill } from '../components/ui';
import { colors, radius, spacing } from '../theme';
import { useApp } from '../lib/store';
import { client, getDeviceHash } from '../lib/api';
import type { Grade } from '@ccat/api-client';
import { ApiError } from '@ccat/api-client';

type Step = 'contact' | 'otp' | 'details';

export function RegisterScreen() {
  const { navigate, setProfile } = useApp();
  const [step, setStep] = useState<Step>('contact');
  const [email, setEmail] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [grant, setGrant] = useState('');
  const [grades, setGrades] = useState<Grade[]>([]);
  const [form, setForm] = useState({ display_name: '', username: '', grade_id: '', birth_month: '', birth_year: '', pin: '' });
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { client.grades().then(setGrades).catch(() => {}); }, []);

  async function sendOtp() {
    setError(null); setLoading(true);
    try {
      const r = await client.registrationContactStart('email', email.trim());
      setChallengeId(r.challenge_id); setDevCode(r._dev_code); setStep('otp');
    } catch (e) { setError(msg(e)); } finally { setLoading(false); }
  }
  async function verifyOtp() {
    setError(null); setLoading(true);
    try {
      const v = await client.registrationContactVerify(challengeId!, code.trim());
      const c = await client.registrationConsent(v.registration_grant, 'v1', 'accepted');
      setGrant(c.registration_grant); setStep('details');
    } catch (e) { setError(msg(e)); } finally { setLoading(false); }
  }
  async function createAccount() {
    setError(null); setLoading(true);
    try {
      const device = await getDeviceHash();
      await client.registrationStudent({
        registration_grant: grant, display_name: form.display_name.trim(), username: form.username.trim(),
        grade_id: form.grade_id, birth_month: Number(form.birth_month), birth_year: Number(form.birth_year),
        pin: form.pin, device_hash: device,
      });
      await client.login(form.username.trim(), form.pin, device);
      setProfile(await client.profile());
      navigate('home');
    } catch (e) { setError(msg(e)); } finally { setLoading(false); }
  }

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        <T variant="h1">Create account</T>
        <Pill label={step === 'contact' ? 'Step 1 of 3 · Guardian' : step === 'otp' ? 'Step 2 of 3 · Verify' : 'Step 3 of 3 · Child'} />
        <View style={{ height: spacing(2) }} />

        {step === 'contact' && (
          <Card>
            <T variant="bodyBold">Guardian email</T>
            <T variant="small">We’ll send a one-time code to confirm a guardian is present.</T>
            <TextInput style={styles.input} autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} placeholder="guardian@email.com" placeholderTextColor={colors.muted} />
          </Card>
        )}

        {step === 'otp' && (
          <Card>
            <T variant="bodyBold">Enter the code</T>
            <T variant="small">Sent to {email}.</T>
            {devCode && <T style={{ color: colors.amber, marginTop: 6 }}>Dev code: {devCode}</T>}
            <TextInput style={styles.input} keyboardType="number-pad" value={code} onChangeText={setCode} placeholder="6-digit code" placeholderTextColor={colors.muted} />
            <TouchableOpacity onPress={() => setConsent(!consent)} style={styles.consent}>
              <View style={[styles.check, consent && { backgroundColor: colors.primary }]} />
              <T variant="small" style={{ flex: 1 }}>Guardian consents to the terms and child-safety policy.</T>
            </TouchableOpacity>
          </Card>
        )}

        {step === 'details' && (
          <Card>
            <Field label="Child’s name" value={form.display_name} onChange={(v) => setForm({ ...form, display_name: v })} />
            <Field label="Username" value={form.username} onChange={(v) => setForm({ ...form, username: v })} autoCapitalize="none" />
            <T variant="bodyBold" style={{ marginTop: spacing(1) }}>Grade</T>
            <View style={styles.grades}>
              {grades.map((g) => (
                <TouchableOpacity key={g.id} onPress={() => setForm({ ...form, grade_id: g.id })} style={[styles.grade, form.grade_id === g.id && styles.gradeOn]}>
                  <T style={[{ fontFamily: 'Nunito_700Bold' }, form.grade_id === g.id && { color: colors.white }]}>{g.name}</T>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.row}>
              <View style={{ flex: 1 }}><Field label="Birth month" value={form.birth_month} onChange={(v) => setForm({ ...form, birth_month: v.replace(/\D/g, '').slice(0, 2) })} keyboardType="number-pad" /></View>
              <View style={{ width: spacing(1.5) }} />
              <View style={{ flex: 1 }}><Field label="Birth year" value={form.birth_year} onChange={(v) => setForm({ ...form, birth_year: v.replace(/\D/g, '').slice(0, 4) })} keyboardType="number-pad" /></View>
            </View>
            <Field label="Choose a 4-digit PIN" value={form.pin} onChange={(v) => setForm({ ...form, pin: v.replace(/\D/g, '').slice(0, 4) })} keyboardType="number-pad" secure />
          </Card>
        )}

        {error && <T style={{ color: colors.coral, marginBottom: spacing(1) }}>{error}</T>}

        {step === 'contact' && <Button title="Send code" onPress={sendOtp} loading={loading} disabled={!email.includes('@')} />}
        {step === 'otp' && <Button title="Verify & continue" onPress={verifyOtp} loading={loading} disabled={code.length < 4 || !consent} />}
        {step === 'details' && <Button title="Create account" onPress={createAccount} loading={loading} disabled={!form.display_name || form.username.length < 3 || !form.grade_id || form.pin.length !== 4 || form.birth_month === '' || form.birth_year.length !== 4} />}
        <View style={{ height: spacing(1.5) }} />
        <Button title="Back" variant="secondary" onPress={() => navigate('welcome')} />
        <View style={{ height: spacing(4) }} />
      </ScrollView>
    </Screen>
  );
}

function Field(props: { label: string; value: string; onChange: (v: string) => void; keyboardType?: any; secure?: boolean; autoCapitalize?: any }) {
  return (
    <View style={{ marginTop: spacing(1) }}>
      <T variant="bodyBold">{props.label}</T>
      <TextInput style={styles.input} value={props.value} onChangeText={props.onChange} keyboardType={props.keyboardType} secureTextEntry={props.secure} autoCapitalize={props.autoCapitalize} placeholderTextColor={colors.muted} />
    </View>
  );
}

function msg(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'USERNAME_TAKEN') return 'That username is taken — try another.';
    if (e.code === 'VALIDATION_ERROR') return 'Please check the details and try again.';
    return e.message;
  }
  return 'Something went wrong';
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: spacing(1.5), paddingVertical: spacing(1.25), marginTop: spacing(0.5), fontFamily: 'Nunito_400Regular', fontSize: 16, color: colors.ink },
  consent: { flexDirection: 'row', alignItems: 'center', marginTop: spacing(1.5), gap: spacing(1) },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.primary },
  grades: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(1), marginTop: spacing(0.5) },
  grade: { paddingHorizontal: spacing(2), paddingVertical: spacing(1), borderRadius: radius.pill, backgroundColor: colors.bgTintBlue },
  gradeOn: { backgroundColor: colors.primary },
  row: { flexDirection: 'row', marginTop: spacing(0.5) },
});
