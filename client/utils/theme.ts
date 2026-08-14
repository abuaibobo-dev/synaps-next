// Synaps Design Tokens - Light: 白底灰字 / Dark: 黑底白字
export interface ThemeColors {
  bgRoot: string;
  bgCard: string;
  bgCardHighlight: string;
  bgInput: string;
  bgElevated: string;
  primary: string;
  primaryDark: string;
  primaryLight: string;
  primaryGlow: string;
  primaryBorder: string;
  success: string;
  warning: string;
  error: string;
  danger: string;
  info: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  borderLight: string;
  separator: string;
}

export const lightColors: ThemeColors = {
  // Backgrounds
  bgRoot: '#FFFFFF',
  bgCard: '#F7F7F9',
  bgCardHighlight: '#EFEFF3',
  bgInput: '#F2F2F5',
  bgElevated: '#FFFFFF',

  // Primary - Purple
  primary: '#6D28D9',
  primaryDark: '#5B21B6',
  primaryLight: '#8B5CF6',
  primaryGlow: 'rgba(109,40,217,0.08)',
  primaryBorder: 'rgba(109,40,217,0.18)',

  // Status
  success: '#059669',
  warning: '#D97706',
  error: '#DC2626',
  danger: '#DC2626',
  info: '#2563EB',

  // Text - 灰字
  textPrimary: '#374151',
  textSecondary: '#6B7280',
  textMuted: '#9CA3AF',

  // Borders
  border: 'rgba(107,114,128,0.18)',
  borderLight: 'rgba(0,0,0,0.06)',
  separator: 'rgba(0,0,0,0.05)',
};

export const darkColors: ThemeColors = {
  // Backgrounds
  bgRoot: '#000000',
  bgCard: '#111114',
  bgCardHighlight: '#1A1A1E',
  bgInput: '#16161A',
  bgElevated: '#1F1F24',

  // Primary - Purple
  primary: '#A78BFA',
  primaryDark: '#7C3AED',
  primaryLight: '#C4B5FD',
  primaryGlow: 'rgba(167,139,250,0.15)',
  primaryBorder: 'rgba(167,139,250,0.22)',

  // Status
  success: '#00FF88',
  warning: '#FBBF24',
  error: '#EF4444',
  danger: '#EF4444',
  info: '#60A5FA',

  // Text - 白字
  textPrimary: '#FFFFFF',
  textSecondary: '#C7C7CC',
  textMuted: '#8E8E96',

  // Borders
  border: 'rgba(255,255,255,0.12)',
  borderLight: 'rgba(255,255,255,0.06)',
  separator: 'rgba(255,255,255,0.04)',
};

// 兼容旧引用（默认深色）
export const colors = darkColors;

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
