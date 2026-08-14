import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable } from 'react-native';
import { Screen } from '@/components/Screen';
import { MenuButton } from '@/components/Sidebar';
import { AppIcon, toolIcon } from '@/components/AppIcon';
import { StepStatusIcon, AnimatedProgressBar, useEntry, PressableScale } from '@/components/motion';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';
import { useThemeColors } from '@/components/ThemeProvider';
import { useFocusEffect } from 'expo-router';
import { getApiBase } from '@/utils';

const API_BASE = getApiBase();

interface TaskStepRow {
  name: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

interface TaskToolRow {
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  ok?: boolean;
  durationMs?: number;
  ts: number;
}

interface TaskItem {
  id: string;
  project_id: string | null;
  name: string;
  status: 'running' | 'done' | 'cancelled' | 'error';
  steps_json: string;
  tools_json: string;
  files_json: string;
  started_at: number;
  ended_at: number | null;
}

const STATUS_META: Record<TaskItem['status'], { text: string; color: string }> = {
  running: { text: '执行中', color: '#555555' },
  done: { text: '已完成', color: '#4CAF50' },
  cancelled: { text: '已取消', color: '#9CA3AF' },
  error: { text: '出错', color: '#F44336' },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(ms?: number | null): string {
  if (!ms) return '--';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

interface TasksScreenProps {
  onOpenSidebar: () => void;
}

export default function TasksScreen({ onOpenSidebar }: TasksScreenProps) {
  const { colors, isDark } = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const cardEntry = useEntry('card');

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/tasks?limit=50`);
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch {
      // 后端不可用时保留旧数据
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchTasks();
      const timer = setInterval(fetchTasks, 5000);
      return () => clearInterval(timer);
    }, [fetchTasks])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchTasks();
    setRefreshing(false);
  }, [fetchTasks]);

  const renderTask = ({ item }: { item: TaskItem }) => {
    const meta = STATUS_META[item.status];
    let steps: TaskStepRow[] = [];
    let tools: TaskToolRow[] = [];
    let files: string[] = [];
    try {
      steps = JSON.parse(item.steps_json || '[]');
      tools = JSON.parse(item.tools_json || '[]');
      files = JSON.parse(item.files_json || '[]');
    } catch {
      // ignore malformed json
    }
    const doneSteps = steps.filter((s) => s.status === 'done' || s.status === 'error').length;
    const progress = steps.length > 0 ? doneSteps / steps.length : item.status === 'running' ? 0.08 : 1;
    const expanded = expandedId === item.id;

    return (
      <PressableScale style={styles.taskCard} onPress={() => setExpandedId(expanded ? null : item.id)}>
        <View style={styles.taskHeader}>
          <View style={styles.taskIcon}>
            <AppIcon name={item.status === 'error' ? 'x-circle' : item.status === 'done' ? 'check-circle' : item.status === 'running' ? 'loader' : 'circle'} size={16} color={meta.color} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.taskName} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.taskMeta}>
              {formatTime(item.started_at)} · {formatDuration(item.ended_at ? item.ended_at - item.started_at : null)}
            </Text>
          </View>
          <Text style={[styles.taskStatus, { color: meta.color }]}>{meta.text}</Text>
          <AppIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
        </View>

        <AnimatedProgressBar
          progress={Math.max(0, Math.min(1, progress))}
          color={meta.color}
          trackColor={colors.bgInput}
          height={4}
        />

        {expanded && (
          <View style={styles.taskDetail}>
            {steps.length > 0 && (
              <View style={styles.detailSection}>
                <Text style={styles.detailTitle}>执行步骤（{doneSteps}/{steps.length}）</Text>
                {steps.map((s, i) => (
                  <View key={i} style={styles.stepRow}>
                    <StepStatusIcon status={s.status} size={13} />
                    <Text style={styles.stepName}>{s.name}</Text>
                  </View>
                ))}
              </View>
            )}
            {tools.length > 0 && (
              <View style={styles.detailSection}>
                <Text style={styles.detailTitle}>工具调用（{tools.length}）</Text>
                {tools.map((t, i) => (
                  <View key={i} style={styles.toolRow}>
                    <AppIcon name={t.ok === false ? 'x-circle' : toolIcon(t.name)} size={11} color={t.ok === false ? '#F44336' : colors.primary} />
                    <Text style={styles.toolName} numberOfLines={1}>{t.name}</Text>
                    <Text style={styles.toolDuration}>{formatDuration(t.durationMs)}</Text>
                  </View>
                ))}
              </View>
            )}
            {files.length > 0 && (
              <View style={styles.detailSection}>
                <Text style={styles.detailTitle}>文件修改（{files.length}）</Text>
                {files.map((f, i) => (
                  <View key={i} style={styles.toolRow}>
                    <AppIcon name="file-pen" size={11} color={colors.success} />
                    <Text style={styles.fileName} numberOfLines={1}>{f}</Text>
                  </View>
                ))}
              </View>
            )}
            {steps.length === 0 && tools.length === 0 && (
              <Text style={styles.mutedText}>该任务没有工具调用记录</Text>
            )}
          </View>
        )}
      </PressableScale>
    );
  };

  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle={isDark ? 'light' : 'dark'} scrollable>
      <View style={styles.container}>
        <View style={styles.header}>
          <MenuButton onPress={onOpenSidebar} />
          <Text style={styles.headerTitle}>任务</Text>
          <View style={styles.taskCount}>
            <Text style={styles.taskCountText}>{tasks.filter((t) => t.status === 'running').length} 执行中</Text>
          </View>
        </View>

        <FlatList
          data={tasks}
          keyExtractor={(item) => item.id}
          renderItem={renderTask}
          contentContainerStyle={styles.listContent}
          refreshing={refreshing}
          onRefresh={onRefresh}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <View style={styles.emptyIcon}>
                <AppIcon name="list-checks" size={26} color={colors.textMuted} />
              </View>
              <Text style={styles.emptyTitle}>暂无任务</Text>
              <Text style={styles.emptyDesc}>在 Agent 页发起对话后，任务会实时显示在这里</Text>
            </View>
          }
        />
      </View>
    </Screen>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
    taskCount: {
      paddingHorizontal: spacing.md,
      paddingVertical: 4,
      borderRadius: radius.sm,
      backgroundColor: colors.primaryGlow,
      borderWidth: 1,
      borderColor: colors.primaryBorder,
    },
    taskCountText: {
      fontSize: fontSize.xs,
      color: colors.primary,
      fontWeight: '600',
    },
    listContent: {
      paddingBottom: spacing.xl,
      gap: spacing.sm,
    },
    taskCard: {
      backgroundColor: colors.bgCard,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      gap: 10,
    },
    taskHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    taskIcon: {
      width: 30,
      height: 30,
      borderRadius: radius.sm + 2,
      backgroundColor: colors.primaryGlow,
      alignItems: 'center',
      justifyContent: 'center',
    },
    taskName: {
      fontSize: fontSize.md,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    taskMeta: {
      fontSize: fontSize.xs,
      color: colors.textMuted,
      marginTop: 2,
    },
    taskStatus: {
      fontSize: fontSize.xs,
      fontWeight: '700',
    },
    taskDetail: {
      borderTopWidth: 1,
      borderTopColor: colors.separator,
      paddingTop: spacing.md,
      gap: spacing.md,
    },
    detailSection: {
      gap: 4,
    },
    detailTitle: {
      fontSize: fontSize.xs,
      fontWeight: '700',
      color: colors.textSecondary,
      letterSpacing: 1,
    },
    stepRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 2,
    },
    stepName: {
      flex: 1,
      fontSize: fontSize.sm,
      color: colors.textPrimary,
      fontFamily: 'monospace',
    },
    toolRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 2,
    },
    toolName: {
      flex: 1,
      fontSize: fontSize.sm,
      color: colors.textPrimary,
      fontWeight: '500',
    },
    toolDuration: {
      fontSize: fontSize.xs,
      color: colors.textMuted,
    },
    fileName: {
      flex: 1,
      fontSize: fontSize.sm,
      color: colors.textPrimary,
      fontFamily: 'monospace',
    },
    mutedText: {
      fontSize: fontSize.xs,
      color: colors.textMuted,
    },
    emptyState: {
      alignItems: 'center',
      paddingTop: spacing.xxl * 2,
      gap: 6,
    },
    emptyIcon: {
      width: 56,
      height: 56,
      borderRadius: radius.lg,
      backgroundColor: colors.bgCard,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.sm,
    },
    emptyTitle: {
      fontSize: fontSize.md,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    emptyDesc: {
      fontSize: fontSize.sm,
      color: colors.textMuted,
    },
  });
