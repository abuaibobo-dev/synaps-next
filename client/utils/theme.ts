// Synaps Design Tokens - Light: 白底灰字 / Dark: 黑底白字（白灰搭配，仅状态色保留彩色）
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

// 皮肤（主题色）预设：白灰搭配，单一石墨强调色
export type AccentKey = 'gray';

interface AccentPalette {
  label: string;
  swatch: string;
  light: {
    primary: string;
    primaryDark: string;
    primaryLight: string;
    primaryGlow: string;
    primaryBorder: string;
  };
  dark: {
    primary: string;
    primaryDark: string;
    primaryLight: string;
    primaryGlow: string;
    primaryBorder: string;
  };
}

export const ACCENTS: Record<AccentKey, AccentPalette> = {
  gray: {
    label: '石墨',
    swatch: '#3A3A3A',
    light: {
      primary: '#3A3A3A',
      primaryDark: '#2A2A2A',
      primaryLight: '#555555',
      primaryGlow: 'rgba(58,58,58,0.08)',
      primaryBorder: 'rgba(58,58,58,0.18)',
    },
    dark: {
      primary: '#3A3A3A',
      primaryDark: '#2A2A2A',
      primaryLight: '#555555',
      primaryGlow: 'rgba(85,85,85,0.20)',
      primaryBorder: 'rgba(255,255,255,0.14)',
    },
  },
};

const lightBase: Omit<ThemeColors, 'primary' | 'primaryDark' | 'primaryLight' | 'primaryGlow' | 'primaryBorder'> = {
  // Backgrounds
  bgRoot: '#F5F5F5',
  bgCard: '#FFFFFF',
  bgCardHighlight: '#F0F0F0',
  bgInput: '#F0F0F0',
  bgElevated: '#FFFFFF',

  // Status
  success: '#4CAF50',
  warning: '#FF9800',
  error: '#F44336',
  danger: '#F44336',
  info: '#555555',

  // Text - 灰字
  textPrimary: '#1A1A1A',
  textSecondary: '#6A6A6A',
  textMuted: '#A0A0A0',

  // Borders
  border: 'rgba(0,0,0,0.12)',
  borderLight: 'rgba(0,0,0,0.05)',
  separator: '#E0E0E0',
};

const darkBase: Omit<ThemeColors, 'primary' | 'primaryDark' | 'primaryLight' | 'primaryGlow' | 'primaryBorder'> = {
  // Backgrounds
  bgRoot: '#0D0D0D',
  bgCard: '#1A1A1A',
  bgCardHighlight: '#242424',
  bgInput: '#242424',
  bgElevated: '#242424',

  // Status
  success: '#4CAF50',
  warning: '#FF9800',
  error: '#F44336',
  danger: '#F44336',
  info: '#555555',

  // Text - 白字
  textPrimary: '#FFFFFF',
  textSecondary: '#B0B0B0',
  textMuted: '#6A6A6A',

  // Borders
  border: 'rgba(255,255,255,0.12)',
  borderLight: 'rgba(255,255,255,0.06)',
  separator: '#2A2A2A',
};

export function buildThemeColors(accent: AccentKey, isDark: boolean): ThemeColors {
  const base = isDark ? darkBase : lightBase;
  const accentColors = ACCENTS[accent][isDark ? 'dark' : 'light'];
  return { ...base, ...accentColors };
}

export const lightColors: ThemeColors = buildThemeColors('gray', false);
export const darkColors: ThemeColors = buildThemeColors('gray', true);

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
