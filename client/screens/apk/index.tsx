import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator } from 'react-native';
import { Screen } from '@/components/Screen';
import { MenuButton } from '@/components/Sidebar';

import { getApiBase } from '@/utils';
const API_BASE = getApiBase();
import { FontAwesome6 } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';
import { useThemeColors } from '@/components/ThemeProvider';


interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  head_branch: string;
  head_sha: string;
}

interface ApksScreenProps {
  onOpenSidebar: () => void;
}

export default function ApksScreen({ onOpenSidebar }: ApksScreenProps) {
  const { colors, isDark } = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');

  const fetchRuns = useCallback(async () => {
    if (!owner || !repo) return;
    setLoading(true);
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/github/workflows?owner=${owner}&repo=${repo}`
      );
      if (response.ok) {
        const data = await response.json();
        setRuns(data.runs || []);
      }
    } catch (error) {
      console.error('Error fetching runs:', error);
    } finally {
      setLoading(false);
    }
  }, [owner, repo]);

  useFocusEffect(
    useCallback(() => {
      // Auto-load if owner/repo are set
      if (owner && repo) {
        fetchRuns();
      }
    }, [fetchRuns, owner, repo])
  );

  const getStatusColor = (status: string, conclusion: string | null) => {
    if (status === 'completed') {
      if (conclusion === 'success') return colors.success;
      if (conclusion === 'failure') return colors.danger;
      return colors.warning;
    }
    if (status === 'in_progress' || status === 'queued') return colors.primary;
    return colors.textMuted;
  };

  const getStatusIcon = (status: string, conclusion: string | null) => {
    if (status === 'completed') {
      if (conclusion === 'success') return 'check-circle';
      if (conclusion === 'failure') return 'times-circle';
      return 'exclamation-circle';
    }
    if (status === 'in_progress') return 'spinner';
    if (status === 'queued') return 'clock';
    return 'circle';
  };

  const renderRun = ({ item }: { item: WorkflowRun }) => (
    <View style={styles.runCard}>
      <View style={styles.runHeader}>
        <View style={[styles.statusDot, { backgroundColor: getStatusColor(item.status, item.conclusion) }]} />
        <Text style={styles.runName} numberOfLines={1}>{item.name}</Text>
        <FontAwesome6
          name={getStatusIcon(item.status, item.conclusion) as any}
          size={14}
          color={getStatusColor(item.status, item.conclusion)}
        />
      </View>
      <View style={styles.runMeta}>
        <View style={styles.metaItem}>
          <FontAwesome6 name="code-branch" size={10} color={colors.textMuted} />
          <Text style={styles.metaText}>{item.head_branch}</Text>
        </View>
        <Text style={styles.metaText}>
          {new Date(item.created_at).toLocaleString()}
        </Text>
      </View>
      {item.status === 'completed' && item.conclusion && (
        <View style={styles.runFooter}>
          <Text style={[styles.conclusionText, { color: getStatusColor(item.status, item.conclusion) }]}>
            {item.conclusion.toUpperCase()}
          </Text>
        </View>
      )}
      {item.status === 'in_progress' && (
        <View style={styles.runFooter}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.conclusionText, { color: colors.primary }]}>BUILDING...</Text>
        </View>
      )}
    </View>
  );

  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle={isDark ? 'light' : 'dark'}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <MenuButton onPress={onOpenSidebar} />
          <Text style={styles.headerTitle}>构建记录</Text>
          <Pressable style={styles.refreshBtn} onPress={fetchRuns}>
            <FontAwesome6 name="rotate" size={14} color={colors.textSecondary} />
          </Pressable>
        </View>

        {/* Config */}
        <View style={styles.configSection}>
          <Text style={styles.configLabel}>仓库配置</Text>
          <View style={styles.configRow}>
            <View style={styles.configInput}>
              <Text style={styles.configInputLabel}>Owner</Text>
              <Text style={styles.configInputValue}>{owner || '未设置'}</Text>
            </View>
            <View style={styles.configInput}>
              <Text style={styles.configInputLabel}>Repo</Text>
              <Text style={styles.configInputValue}>{repo || '未设置'}</Text>
            </View>
          </View>
          {!owner || !repo ? (
            <Text style={styles.configHint}>在设置中配置 GitHub 仓库信息</Text>
          ) : null}
        </View>

        {/* Build List */}
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <FlatList
            data={runs}
            renderItem={renderRun}
            keyExtractor={(item) => item.id.toString()}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <View style={styles.emptyIcon}>
                  <FontAwesome6 name="hammer" size={28} color={colors.textMuted} />
                </View>
                <Text style={styles.emptyText}>暂无构建记录</Text>
                <Text style={styles.emptyHint}>
                  {owner && repo
                    ? '点击刷新查看最新构建'
                    : '配置仓库后即可查看 GitHub Actions 构建'}
                </Text>
              </View>
            }
          />
        )}
      </View>
    </Screen>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  headerTitle: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  refreshBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  configSection: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  configLabel: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  configRow: { flexDirection: 'row', gap: spacing.md },
  configInput: { flex: 1 },
  configInputLabel: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginBottom: 2,
  },
  configInputValue: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  configHint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  runCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  runHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  runName: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.textPrimary,
    flex: 1,
  },
  runMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: fontSize.xs, color: colors.textMuted },
  runFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  conclusionText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1,
  },
  emptyState: { alignItems: 'center', paddingTop: spacing.xxl * 2 },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  emptyText: { fontSize: fontSize.md, fontWeight: '600', color: colors.textPrimary, marginBottom: spacing.xs },
  emptyHint: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
