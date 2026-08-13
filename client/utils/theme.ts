// Synaps Design Tokens - Cyber Dark with Purple Accent
export const colors = {
  // Backgrounds
  bgRoot: '#0A0A0F',
  bgCard: '#12121A',
  bgCardHighlight: '#1A1A26',
  bgInput: '#16161F',
  bgElevated: '#1E1E2A',

  // Primary - Purple
  primary: '#A78BFA',
  primaryDark: '#7C3AED',
  primaryLight: '#C4B5FD',
  primaryGlow: 'rgba(167,139,250,0.15)',
  primaryBorder: 'rgba(167,139,250,0.12)',

  // Status
  success: '#00FF88',
  warning: '#FBBF24',
  error: '#EF4444',
  danger: '#EF4444',
  info: '#60A5FA',

  // Text
  textPrimary: '#EAEAEA',
  textSecondary: '#6B7280',
  textMuted: '#4B5563',

  // Borders
  border: 'rgba(167,139,250,0.12)',
  borderLight: 'rgba(255,255,255,0.06)',
  separator: 'rgba(255,255,255,0.04)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
} as const;

export const fontSize = {
  xs: 10,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;
