import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { Uniwind } from 'uniwind';
import { darkColors, lightColors } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'synaps.theme.mode';

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  isDark: boolean;
  colors: ThemeColors;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  setMode: () => {},
  isDark: true,
  colors: darkColors,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemColorScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [webScheme, setWebScheme] = useState<'light' | 'dark' | null>(null);

  // 读取持久化主题模式
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => {
        if (v === 'light' || v === 'dark' || v === 'system') {
          setModeState(v);
          Uniwind.setTheme(v);
        }
      })
      .catch(() => {});
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
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
    Uniwind.setTheme(next);
  }, []);

  // 跟随 Uniwind 主题（原生端会同步 Appearance.setColorScheme）
  useEffect(() => {
    Uniwind.setTheme(mode);
  }, [mode]);

  const systemScheme: 'light' | 'dark' = webScheme ?? systemColorScheme ?? 'dark';
  const resolvedMode: 'light' | 'dark' = mode === 'system' ? systemScheme : mode;
  const isDark = resolvedMode === 'dark';
  const colors = isDark ? darkColors : lightColors;

  const value = useMemo(() => ({ mode, setMode, isDark, colors }), [mode, setMode, isDark, colors]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeColors() {
  return useContext(ThemeContext);
}
