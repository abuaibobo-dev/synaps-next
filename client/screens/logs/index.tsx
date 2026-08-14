import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Screen } from '@/components/Screen';
import { MenuButton } from '@/components/Sidebar';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';
import { useThemeColors } from '@/components/ThemeProvider';
import { FontAwesome6 } from '@expo/vector-icons';

interface LogsScreenProps {
  onOpenSidebar: () => void;
}

const LOG_CATEGORIES = [
  { key: 'agent', label: 'Agent 日志', icon: 'robot' as const, count: 0 },
  { key: 'build', label: '构建日志', icon: 'hammer' as const, count: 0 },
  { key: 'shell', label: 'Shell 日志', icon: 'terminal' as const, count: 0 },
  { key: 'system', label: '系统日志', icon: 'microchip' as const, count: 0 },
];

export default function LogsScreen({ onOpenSidebar }: LogsScreenProps) {
  const { colors, isDark } = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle={isDark ? 'light' : 'dark'}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <MenuButton onPress={onOpenSidebar} />
          <Text style={styles.headerTitle}>日志</Text>
        </View>

        {/* Log Categories */}
        <View style={styles.categoryGrid}>
          {LOG_CATEGORIES.map((cat) => (
            <View key={cat.key} style={styles.categoryCard}>
              <View style={styles.categoryIcon}>
                <FontAwesome6 name={cat.icon} size={16} color={colors.primary} />
              </View>
              <Text style={styles.categoryLabel}>{cat.label}</Text>
              <Text style={styles.categoryCount}>{cat.count}</Text>
            </View>
          ))}
        </View>

        {/* Log Content */}
        <View style={styles.logPanel}>
          <View style={styles.logPanelHeader}>
            <Text style={styles.logPanelTitle}>日志输出</Text>
            <View style={styles.logFilter}>
              <Text style={styles.filterText}>ALL</Text>
            </View>
          </View>

          <View style={styles.logContent}>
            <Text style={styles.logEmpty}>
              {'// 日志将在此显示\n// Agent 执行、构建过程、Shell 输出\n// 均可通过 AI 分析定位问题'}
            </Text>
          </View>
        </View>
      </View>
    </Screen>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  headerTitle: {
    flex: 1,
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  categoryCard: {
    width: '48%',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  categoryIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm + 2,
    backgroundColor: colors.primaryGlow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryLabel: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  categoryCount: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    fontFamily: 'monospace',
  },
  logPanel: {
    flex: 1,
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  logPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  logPanelTitle: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  logFilter: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  filterText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    letterSpacing: 1,
    fontWeight: '600',
  },
  logContent: {
    flex: 1,
    padding: spacing.lg,
  },
  logEmpty: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    fontFamily: 'monospace',
    lineHeight: 22,
  },
});
