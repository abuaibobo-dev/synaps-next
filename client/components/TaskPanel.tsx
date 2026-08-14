import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';

export interface TaskToolRecord {
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  ok?: boolean;
  durationMs?: number;
  ts: number;
}

export interface TaskStep {
  name: string;
  status: 'running' | 'done' | 'error' | 'pending';
}

export interface TaskRecord {
  id: string;
  name: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done' | 'cancelled' | 'error';
  steps: TaskStep[];
  tools: TaskToolRecord[];
  files: string[];
}

const FILE_TOOLS = new Set([
  'write_file',
  'auto_fix',
  'security_fix',
  'generate_tests',
  'auto_test_fix',
  'team_execute',
  'project_import',
]);

export function isFileModifyingTool(tool: string, args?: Record<string, unknown>): boolean {
  if (!FILE_TOOLS.has(tool)) return false;
  return typeof args?.path === 'string' || typeof args?.query === 'string' || tool === 'team_execute';
}

function formatDuration(ms?: number): string {
  if (!ms) return '--';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

const STEP_ICON: Record<TaskStep['status'], { icon: string; color: string }> = {
  done: { icon: 'circle-check', color: '#22C55E' },
  running: { icon: 'hourglass-half', color: '#F59E0B' },
  pending: { icon: 'circle', color: '#9CA3AF' },
  error: { icon: 'circle-xmark', color: '#EF4444' },
};

const STATUS_LABEL: Record<TaskRecord['status'], { text: string; color: string }> = {
  running: { text: '执行中', color: '#F59E0B' },
  done: { text: '已完成', color: '#22C55E' },
  cancelled: { text: '已取消', color: '#9CA3AF' },
  error: { text: '出错', color: '#EF4444' },
};

interface TaskPanelProps {
  task: TaskRecord | null;
  colors: ThemeColors;
  isDark: boolean;
  onCancel: () => void;
  onRerun: () => void;
  onRollback: () => void;
}

export default function TaskPanel({ task, colors, isDark, onCancel, onRerun, onRollback }: TaskPanelProps) {
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (!task) {
    return (
      <View style={styles.empty}>
        <View style={styles.emptyIcon}>
          <FontAwesome6 name="list-check" size={22} color={colors.textMuted} />
        </View>
        <Text style={styles.emptyTitle}>暂无任务</Text>
        <Text style={styles.emptyDesc}>开始对话后，任务将显示在这里</Text>
      </View>
    );
  }

  const status = STATUS_LABEL[task.status];
  const totalSteps = task.steps.length;
  const doneSteps = task.steps.filter((s) => s.status === 'done' || s.status === 'error').length;
  const progress = totalSteps > 0 ? doneSteps / totalSteps : task.tools.length > 0 ? 0.5 : 0;

  return (
    <View style={styles.container}>
      {/* 头部 */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>任务面板</Text>
        <View style={[styles.statusBadge, { borderColor: status.color, backgroundColor: isDark ? status.color + '22' : status.color + '14' }]}>
          <Text style={[styles.statusText, { color: status.color }]}>{status.text}</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
        {/* 任务信息 */}
        <View style={styles.card}>
          <Text style={styles.taskName}>{task.name}</Text>
          <Text style={styles.taskMeta}>
            开始 {formatClock(task.startedAt)}
            {task.endedAt ? ` · 耗时 ${formatDuration(task.endedAt - task.startedAt)}` : ' · 执行中...'}
          </Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.max(4, Math.round(progress * 100))}%` }]} />
          </View>
          <Text style={styles.progressText}>
            {doneSteps}/{totalSteps || task.tools.length} 步
          </Text>
        </View>

        {/* 控制按钮 */}
        <View style={styles.actions}>
          {task.status === 'running' && (
            <Pressable style={[styles.actionBtn, styles.cancelBtn]} onPress={onCancel}>
              <FontAwesome6 name="stop" size={11} color="#FFFFFF" />
              <Text style={styles.cancelBtnText}>取消</Text>
            </Pressable>
          )}
          <Pressable style={[styles.actionBtn, styles.secondaryBtn]} onPress={onRerun}>
            <FontAwesome6 name="rotate-right" size={11} color={colors.primary} />
            <Text style={styles.secondaryBtnText}>重跑</Text>
          </Pressable>
          <Pressable style={[styles.actionBtn, styles.secondaryBtn]} onPress={onRollback}>
            <FontAwesome6 name="rotate-left" size={11} color={colors.warning} />
            <Text style={[styles.secondaryBtnText, { color: colors.warning }]}>回滚</Text>
          </Pressable>
        </View>

        {/* 步骤列表 */}
        <Text style={styles.sectionTitle}>执行步骤</Text>
        <View style={styles.card}>
          {task.steps.length === 0 ? (
            <Text style={styles.mutedText}>等待 Agent 开始执行...</Text>
          ) : (
            task.steps.map((step, i) => {
              const icon = STEP_ICON[step.status];
              return (
                <View key={i} style={styles.stepRow}>
                  <FontAwesome6 name={icon.icon} size={12} color={icon.color} />
                  <Text style={[styles.stepName, step.status === 'running' && { color: icon.color }]}>
                    {step.name}
                  </Text>
                  {step.status === 'running' && <Text style={styles.stepHint}>执行中...</Text>}
                </View>
              );
            })
          )}
        </View>

        {/* 工具调用记录 */}
        <Text style={styles.sectionTitle}>工具调用</Text>
        <View style={styles.card}>
          {task.tools.length === 0 ? (
            <Text style={styles.mutedText}>暂无工具调用</Text>
          ) : (
            task.tools.map((t, i) => (
              <View key={i} style={styles.toolRow}>
                <View style={styles.toolRowHeader}>
                  <FontAwesome6
                    name={t.ok === false ? 'circle-xmark' : 'terminal'}
                    size={11}
                    color={t.ok === false ? '#EF4444' : colors.primary}
                  />
                  <Text style={styles.toolName}>{t.name}</Text>
                  <Text style={styles.toolDuration}>{formatDuration(t.durationMs)}</Text>
                </View>
                {t.args && Object.keys(t.args).length > 0 && (
                  <Text style={styles.toolArgs} numberOfLines={1}>
                    {JSON.stringify(t.args).slice(0, 120)}
                  </Text>
                )}
                {t.result ? (
                  <Text style={[styles.toolResult, t.ok === false && styles.toolResultError]} numberOfLines={2}>
                    {t.result.length > 200 ? `${t.result.slice(0, 200)}…` : t.result}
                  </Text>
                ) : null}
              </View>
            ))
          )}
        </View>

        {/* 关联文件 */}
        <Text style={styles.sectionTitle}>文件修改</Text>
        <View style={styles.card}>
          {task.files.length === 0 ? (
            <Text style={styles.mutedText}>暂无文件修改</Text>
          ) : (
            task.files.map((f, i) => (
              <View key={i} style={styles.fileRow}>
                <FontAwesome6 name="file-pen" size={11} color={colors.success} />
                <Text style={styles.fileName}>{f}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgRoot,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  statusBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  statusText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  body: {
    padding: spacing.md,
    gap: spacing.sm,
    paddingBottom: spacing.xl,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 6,
  },
  taskName: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  taskMeta: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.bgInput,
    overflow: 'hidden',
    marginTop: 4,
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  progressText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    textAlign: 'right',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: radius.md,
  },
  cancelBtn: {
    backgroundColor: '#EF4444',
  },
  cancelBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  secondaryBtn: {
    backgroundColor: colors.primaryGlow,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  secondaryBtnText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  sectionTitle: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.textSecondary,
    marginTop: 2,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 3,
  },
  stepName: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontFamily: 'monospace',
  },
  stepHint: {
    fontSize: fontSize.xs,
    color: '#F59E0B',
  },
  toolRow: {
    gap: 2,
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  toolRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  toolName: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  toolDuration: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  toolArgs: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    fontFamily: 'monospace',
  },
  toolResult: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontFamily: 'monospace',
  },
  toolResultError: {
    color: '#EF4444',
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 3,
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
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: 8,
  },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
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
