import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useThemeColors } from '@/components/ThemeProvider';
import type { ThemeColors } from '@/utils/theme';
import { spacing, fontSize } from '@/utils/theme';
import { getApiBase } from '@/utils';

const API_BASE = getApiBase();
const CHECK_INTERVAL = 8000;

export default function OfflineBanner() {
  const { colors } = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [offline, setOffline] = useState(false);
  const checkingRef = useRef(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const check = async () => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${API_BASE}/api/v1/health`, { signal: controller.signal });
        clearTimeout(timeout);
        if (active) setOffline(!res.ok);
      } catch {
        if (active) setOffline(true);
      } finally {
        checkingRef.current = false;
      }
    };

    check();
    timer = setInterval(check, CHECK_INTERVAL);
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  if (!offline) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.text}>
        离线模式：后端服务未连接，Agent / 终端 / 工具功能暂不可用
      </Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: 'rgba(245,158,11,0.14)',
      borderBottomWidth: 1,
      borderBottomColor: colors.warning,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm + 2,
    },
    text: {
      flex: 1,
      fontSize: fontSize.xs,
      color: colors.textSecondary,
      lineHeight: 16,
    },
  });
