import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { Uniwind } from 'uniwind';
import { buildThemeColors, ACCENTS } from '@/utils/theme';
import type { ThemeColors, AccentKey } from '@/utils/theme';

export type ThemeMode = 'system' | 'light' | 'dark';

const MODE_KEY = 'synaps.theme.mode';
const ACCENT_KEY = 'synaps.theme.accent';

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  accent: AccentKey;
  setAccent: (accent: AccentKey) => void;
  isDark: boolean;
  colors: ThemeColors;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  setMode: () => {},
  accent: 'gray',
  setAccent: () => {},
  isDark: true,
  colors: buildThemeColors('gray', true),
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemColorScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [accent, setAccentState] = useState<AccentKey>('gray');
  const [webScheme, setWebScheme] = useState<'light' | 'dark' | null>(null);

  // 读取持久化主题模式与皮肤
  useEffect(() => {
    (async () => {
      try {
        const [m, a] = await Promise.all([
          AsyncStorage.getItem(MODE_KEY),
          AsyncStorage.getItem(ACCENT_KEY),
        ]);
        if (m === 'light' || m === 'dark' || m === 'system') {
          setModeState(m);
          Uniwind.setTheme(m);
        }
        if (a && a in ACCENTS) {
          setAccentState(a as AccentKey);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  // web 宿主（coze workbench）下发系统外观
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    function handleMessage(e: MessageEvent<{ event: string; colorScheme?: string }>) {
      if (e.data?.event === 'coze.workbench.colorScheme' && (e.data.colorScheme === 'light' || e.data.colorScheme === 'dark')) {
        setWebScheme(e.data.colorScheme);
      }
    }
    window.addEventListener('message', handleMessage, false);
    return () => window.removeEventListener('message', handleMessage, false);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    AsyncStorage.setItem(MODE_KEY, next).catch(() => {});
    Uniwind.setTheme(next);
  }, []);

  const setAccent = useCallback((next: AccentKey) => {
    setAccentState(next);
    AsyncStorage.setItem(ACCENT_KEY, next).catch(() => {});
  }, []);

  // 跟随 Uniwind 主题（原生端会同步 Appearance.setColorScheme）
  useEffect(() => {
    Uniwind.setTheme(mode);
  }, [mode]);

  const systemScheme: 'light' | 'dark' = webScheme ?? systemColorScheme ?? 'dark';
  const resolvedMode: 'light' | 'dark' = mode === 'system' ? systemScheme : mode;
  const isDark = resolvedMode === 'dark';
  const colors = useMemo(() => buildThemeColors(accent, isDark), [accent, isDark]);

  const value = useMemo(
    () => ({ mode, setMode, accent, setAccent, isDark, colors }),
    [mode, setMode, accent, setAccent, isDark, colors]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeColors() {
  return useContext(ThemeContext);
}
