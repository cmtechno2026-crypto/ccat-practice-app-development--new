import React from 'react';
import { Text, TextProps, TouchableOpacity, View, ViewProps, StyleSheet, ActivityIndicator } from 'react-native';
import { colors, radius, spacing, type } from '../theme';

export function T(props: TextProps & { variant?: keyof typeof type }) {
  const { variant = 'body', style, ...rest } = props;
  return <Text {...rest} style={[type[variant], style]} />;
}

export function Card(props: ViewProps) {
  return <View {...props} style={[styles.card, props.style]} />;
}

export function Screen(props: ViewProps & { center?: boolean }) {
  const { center, style, ...rest } = props;
  return <View {...rest} style={[styles.screen, center && styles.center, style]} />;
}

export function Button(props: {
  title: string; onPress: () => void; loading?: boolean; disabled?: boolean;
  variant?: 'primary' | 'secondary';
}) {
  const secondary = props.variant === 'secondary';
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      disabled={props.disabled || props.loading}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.title}
      accessibilityState={{ disabled: !!(props.disabled || props.loading), busy: !!props.loading }}
      style={[styles.btn, secondary && styles.btnSecondary, (props.disabled || props.loading) && styles.btnDisabled]}
    >
      {props.loading ? (
        <ActivityIndicator color={secondary ? colors.primary : colors.white} />
      ) : (
        <Text style={[styles.btnText, secondary && styles.btnTextSecondary]}>{props.title}</Text>
      )}
    </TouchableOpacity>
  );
}

export function Pill(props: { label: string; tint?: string }) {
  const tint = props.tint ?? colors.bgTintBlue;
  return (
    <View style={[styles.pill, { backgroundColor: tint }]}>
      <Text style={styles.pillText}>{props.label}</Text>
    </View>
  );
}

export function StatTile(props: { label: string; value: string; tint?: string }) {
  return (
    <View style={[styles.stat, { backgroundColor: props.tint ?? colors.bgTintBlue }]} accessible accessibilityLabel={`${props.label}: ${props.value}`}>
      <Text style={styles.statValue} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{props.value}</Text>
      <Text style={styles.statLabel} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{props.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: spacing(2.5) },
  center: { justifyContent: 'center' },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing(2.5),
    borderWidth: 1, borderColor: colors.line, marginBottom: spacing(1.5) },
  btn: { backgroundColor: colors.primary, borderRadius: radius.pill, paddingVertical: spacing(1.75),
    alignItems: 'center', justifyContent: 'center', minHeight: 52 },
  btnSecondary: { backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.primary },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: colors.white, fontFamily: 'Baloo2_600SemiBold', fontSize: 17 },
  btnTextSecondary: { color: colors.primary },
  pill: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: spacing(1.5), paddingVertical: spacing(0.5) },
  pillText: { fontFamily: 'Nunito_700Bold', fontSize: 12, color: colors.inkSoft },
  stat: { flex: 1, borderRadius: radius.md, padding: spacing(1.75), marginHorizontal: spacing(0.5) },
  statValue: { fontFamily: 'Baloo2_700Bold', fontSize: 24, color: colors.ink },
  statLabel: { fontFamily: 'Nunito_400Regular', fontSize: 12, color: colors.muted, marginTop: 2 },
});
