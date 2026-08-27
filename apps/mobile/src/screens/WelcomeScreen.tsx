import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Screen, T, Button } from '../components/ui';
import { colors, spacing } from '../theme';
import { useApp } from '../lib/store';

export function WelcomeScreen() {
  const { navigate } = useApp();
  return (
    <Screen center>
      <View style={styles.hero}>
        <View style={styles.badge}><T style={styles.badgeText}>CM</T></View>
        <T variant="h1" style={styles.title}>CCAT Practice</T>
        <T variant="body" style={styles.sub}>Sharpen verbal, quantitative, and non-verbal reasoning — one set at a time.</T>
      </View>
      <View style={{ height: spacing(4) }} />
      <Button title="Get started" onPress={() => navigate('register')} />
      <View style={{ height: spacing(1.5) }} />
      <Button title="I already have an account" variant="secondary" onPress={() => navigate('login')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center' },
  badge: { width: 72, height: 72, borderRadius: 20, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginBottom: spacing(2) },
  badgeText: { fontFamily: 'Baloo2_700Bold', fontSize: 28, color: colors.white },
  title: { textAlign: 'center' },
  sub: { textAlign: 'center', marginTop: spacing(1), paddingHorizontal: spacing(2) },
});
