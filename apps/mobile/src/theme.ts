// CCAT design tokens — sourced from the approved prototypes (production-ux-spec.md §1).
// Fonts: Baloo 2 (display), Nunito (body). Child-friendly, soft, high-contrast.

export const colors = {
  primary: '#3e7bee',
  primaryDark: '#2f5fc0',
  ink: '#2a2e43',
  inkSoft: '#4a4f66',
  muted: '#8a90a6',
  line: '#e4e8f3',
  bg: '#f7f8fc',
  bgTintBlue: '#eaf0ff',
  bgTintLilac: '#f3ecfb',
  card: '#ffffff',
  purple: '#8b5cf6',
  green: '#22a06b',
  teal: '#22c3a6',
  amber: '#f6a821',
  coral: '#ef5b6b',
  white: '#ffffff',
} as const;

export const radius = { sm: 10, md: 16, lg: 22, pill: 999 } as const;
export const spacing = (n: number) => n * 8;

export const font = {
  display: 'Baloo2_700Bold',
  displaySemi: 'Baloo2_600SemiBold',
  body: 'Nunito_400Regular',
  bodyBold: 'Nunito_700Bold',
} as const;

export const type = {
  h1: { fontFamily: font.display, fontSize: 28, color: colors.ink },
  h2: { fontFamily: font.displaySemi, fontSize: 20, color: colors.ink },
  body: { fontFamily: font.body, fontSize: 16, color: colors.inkSoft },
  bodyBold: { fontFamily: font.bodyBold, fontSize: 16, color: colors.ink },
  small: { fontFamily: font.body, fontSize: 13, color: colors.muted },
} as const;
