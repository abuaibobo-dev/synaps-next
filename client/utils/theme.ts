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

// 皮肤（主题色）预设
export type AccentKey = 'purple' | 'blue' | 'green' | 'orange' | 'pink';

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
  purple: {
    label: '紫',
    swatch: '#7C3AED',
    light: {
      primary: '#6D28D9',
      primaryDark: '#5B21B6',
      primaryLight: '#8B5CF6',
      primaryGlow: 'rgba(109,40,217,0.08)',
      primaryBorder: 'rgba(109,40,217,0.18)',
    },
    dark: {
      primary: '#A78BFA',
      primaryDark: '#7C3AED',
      primaryLight: '#C4B5FD',
      primaryGlow: 'rgba(167,139,250,0.15)',
      primaryBorder: 'rgba(167,139,250,0.22)',
    },
  },
  blue: {
    label: '蓝',
    swatch: '#2563EB',
    light: {
      primary: '#1D4ED8',
      primaryDark: '#1E40AF',
      primaryLight: '#3B82F6',
      primaryGlow: 'rgba(29,78,216,0.08)',
      primaryBorder: 'rgba(29,78,216,0.18)',
    },
    dark: {
      primary: '#60A5FA',
      primaryDark: '#2563EB',
      primaryLight: '#93C5FD',
      primaryGlow: 'rgba(96,165,250,0.15)',
      primaryBorder: 'rgba(96,165,250,0.22)',
    },
  },
  green: {
    label: '绿',
    swatch: '#059669',
    light: {
      primary: '#047857',
      primaryDark: '#065F46',
      primaryLight: '#10B981',
      primaryGlow: 'rgba(4,120,87,0.08)',
      primaryBorder: 'rgba(4,120,87,0.18)',
    },
    dark: {
      primary: '#34D399',
      primaryDark: '#059669',
      primaryLight: '#6EE7B7',
      primaryGlow: 'rgba(52,211,153,0.15)',
      primaryBorder: 'rgba(52,211,153,0.22)',
    },
  },
  orange: {
    label: '橙',
    swatch: '#EA580C',
    light: {
      primary: '#C2410C',
      primaryDark: '#9A3412',
      primaryLight: '#F97316',
      primaryGlow: 'rgba(194,65,12,0.08)',
      primaryBorder: 'rgba(194,65,12,0.18)',
    },
    dark: {
      primary: '#FB923C',
      primaryDark: '#EA580C',
      primaryLight: '#FDBA74',
      primaryGlow: 'rgba(251,146,60,0.15)',
      primaryBorder: 'rgba(251,146,60,0.22)',
    },
  },
  pink: {
    label: '粉',
    swatch: '#DB2777',
    light: {
      primary: '#BE185D',
      primaryDark: '#9D174D',
      primaryLight: '#EC4899',
      primaryGlow: 'rgba(190,24,93,0.08)',
      primaryBorder: 'rgba(190,24,93,0.18)',
    },
    dark: {
      primary: '#F472B6',
      primaryDark: '#DB2777',
      primaryLight: '#F9A8D4',
      primaryGlow: 'rgba(244,114,182,0.15)',
      primaryBorder: 'rgba(244,114,182,0.22)',
    },
  },
};

const lightBase: Omit<ThemeColors, 'primary' | 'primaryDark' | 'primaryLight' | 'primaryGlow' | 'primaryBorder'> = {
  // Backgrounds
  bgRoot: '#FFFFFF',
  bgCard: '#F7F7F9',
  bgCardHighlight: '#EFEFF3',
  bgInput: '#F2F2F5',
  bgElevated: '#FFFFFF',

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

const darkBase: Omit<ThemeColors, 'primary' | 'primaryDark' | 'primaryLight' | 'primaryGlow' | 'primaryBorder'> = {
  // Backgrounds
  bgRoot: '#000000',
  bgCard: '#111114',
  bgCardHighlight: '#1A1A1E',
  bgInput: '#16161A',
  bgElevated: '#1F1F24',

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

export function buildThemeColors(accent: AccentKey, isDark: boolean): ThemeColors {
  const base = isDark ? darkBase : lightBase;
  const accentColors = ACCENTS[accent][isDark ? 'dark' : 'light'];
  return { ...base, ...accentColors };
}

export const lightColors: ThemeColors = buildThemeColors('purple', false);
export const darkColors: ThemeColors = buildThemeColors('purple', true);

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
