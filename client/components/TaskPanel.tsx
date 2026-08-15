import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import Animated from 'react-native-reanimated';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';
import { AppIcon, toolIcon } from './AppIcon';
import {
  useEntry,
  PressableScale,
  StepStatusIcon,
  AnimatedProgressBar,
  CompletionToast,
  type StepStatus,
} from './motion';

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
  status: StepStatus;
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

const STATUS_LABEL: Record<TaskRecord['status'], { text: string; color: string }> = {
  running: { text: '执行中', color: '#555555' },
  done: { text: '已完成', color: '#4CAF50' },
  cancelled: { text: '已取消', color: '#9CA3AF' },
  error: { text: '出错', color: '#F44336' },
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
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const panelEntry = useEntry('panel');
  const cardEntry = useEntry('card');
  const stepEntry = useEntry('step');
  const [expandedTool, setExpandedTool] = useState<number | null>(null);

  if (!task) {
    return (
      <Animated.View {...panelEntry} style={styles.empty}>
        <View style={styles.emptyIcon}>
          <AppIcon name="list-checks" size={22} color={colors.textMuted} />
        </View>
        <Text style={styles.emptyTitle}>暂无任务</Text>
        <Text style={styles.emptyDesc}>开始对话后，任务将显示在这里</Text>
      </Animated.View>
    );
  }

  const status = STATUS_LABEL[task.status];
  const totalSteps = task.steps.length;
  const doneSteps = task.steps.filter((s) => s.status === 'done' || s.status === 'error').length;
  const progress = totalSteps > 0 ? doneSteps / totalSteps : task.tools.length > 0 ? 0.5 : 0;
  const percent = Math.round(progress * 100);
  const failedTools = task.tools.filter((t) => t.ok === false).length;
  const isFinished = task.status === 'done' || task.status === 'error' || task.status === 'cancelled';

  return (
    <Animated.View {...panelEntry} style={styles.container}>
      {/* 头部 */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>任务面板</Text>
        <View style={[styles.statusBadge, { borderColor: status.color, backgroundColor: isDark ? status.color + '22' : status.color + '14' }]}>
          <Text style={[styles.statusText, { color: status.color }]}>{status.text}</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
        {/* 任务信息 */}
        <Animated.View {...cardEntry} style={styles.card}>
          <Text style={styles.taskName}>{task.name}</Text>
          <Text style={styles.taskMeta}>
            开始 {formatClock(task.startedAt)}
            {task.endedAt ? ` · 耗时 ${formatDuration(task.endedAt - task.startedAt)}` : ' · 执行中...'}
          </Text>
          <AnimatedProgressBar
            progress={Math.max(0, Math.min(1, progress))}
            color={colors.primary}
            trackColor={colors.bgInput}
            height={6}
          />
          <Text style={styles.progressText}>
            {percent}% · {doneSteps}/{totalSteps || task.tools.length} 步
            {task.status === 'running' && percent >= 20 ? ` · 已执行 ${percent >= 80 ? '80%+' : percent >= 60 ? '60%+' : percent >= 40 ? '40%+' : '20%+'}` : ''}
          </Text>
        </Animated.View>

        {/* 任务复盘 */}
        {isFinished && (
          <Animated.View {...cardEntry} style={[styles.card, styles.reviewCard]}>
            <View style={styles.reviewHeader}>
              <AppIcon
                name={task.status === 'done' ? 'check-circle' : task.status === 'cancelled' ? 'x-circle' : 'x-circle'}
                size={13}
                color={task.status === 'done' ? '#4CAF50' : task.status === 'cancelled' ? '#9CA3AF' : '#F44336'}
              />
              <Text style={styles.reviewTitle}>
                {task.status === 'done' ? '执行报告 · 完成' : task.status === 'cancelled' ? '执行报告 · 已取消' : '执行报告 · 出错'}
              </Text>
            </View>
            <View style={styles.reviewGrid}>
              <View style={styles.reviewCell}>
                <Text style={styles.reviewNum}>{task.tools.length}</Text>
                <Text style={styles.reviewLabel}>工具调用</Text>
              </View>
              <View style={styles.reviewCell}>
                <Text style={[styles.reviewNum, failedTools > 0 && { color: '#F44336' }]}>{failedTools}</Text>
                <Text style={styles.reviewLabel}>失败工具</Text>
              </View>
              <View style={styles.reviewCell}>
                <Text style={styles.reviewNum}>{task.files.length}</Text>
                <Text style={styles.reviewLabel}>文件改动</Text>
              </View>
              <View style={styles.reviewCell}>
                <Text style={styles.reviewNum}>{formatDuration(task.endedAt ? task.endedAt - task.startedAt : 0)}</Text>
                <Text style={styles.reviewLabel}>总耗时</Text>
              </View>
            </View>
            <Text style={styles.reviewAdvice}>
              {task.status === 'done'
                ? '任务已完成，需要撤销改动可点「回滚」恢复最近快照。'
                : task.status === 'cancelled'
                  ? '任务已手动取消，可点「重跑」重新发起。'
                  : '部分步骤失败，可点「重跑」重试，或展开下方失败工具查看原因。'}
            </Text>
          </Animated.View>
        )}

        {/* 控制按钮 */}
        <View style={styles.actions}>
          {task.status === 'running' && (
            <PressableScale style={[styles.actionBtn, styles.cancelBtn]} onPress={onCancel}>
              <AppIcon name="x" size={11} color="#FFFFFF" />
              <Text style={styles.cancelBtnText}>取消</Text>
            </PressableScale>
          )}
          <PressableScale style={[styles.actionBtn, styles.secondaryBtn]} onPress={onRerun}>
            <AppIcon name="rotate-cw" size={11} color={colors.primary} />
            <Text style={styles.secondaryBtnText}>重跑</Text>
          </PressableScale>
          <PressableScale style={[styles.actionBtn, styles.secondaryBtn]} onPress={onRollback}>
            <AppIcon name="undo" size={11} color={colors.warning} />
            <Text style={[styles.secondaryBtnText, { color: colors.warning }]}>回滚</Text>
          </PressableScale>
        </View>

        {/* 步骤列表 */}
        <Text style={styles.sectionTitle}>执行步骤</Text>
        <View style={styles.card}>
          {task.steps.length === 0 ? (
            <Text style={styles.mutedText}>等待 Agent 开始执行...</Text>
          ) : (
            task.steps.map((step, i) => (
              <Animated.View key={i} {...stepEntry} style={styles.stepRow}>
                <StepStatusIcon status={step.status} size={14} />
                <Text style={[styles.stepName, step.status === 'running' && { color: STATUS_LABEL.running.color }]}>
                  {step.name}
                </Text>
                {step.status === 'running' && <Text style={styles.stepHint}>执行中...</Text>}
              </Animated.View>
            ))
          )}
        </View>

        {/* 工具调用记录 */}
        <Text style={styles.sectionTitle}>工具调用</Text>
        <View style={styles.card}>
          {task.tools.length === 0 ? (
            <Text style={styles.mutedText}>暂无工具调用</Text>
          ) : (
            task.tools.map((t, i) => (
              <Animated.View key={i} {...stepEntry} style={styles.toolRow}>
                <Pressable
                  style={styles.toolRowHeader}
                  onPress={() => setExpandedTool(expandedTool === i ? null : i)}
                >
                  <AppIcon
                    name={t.ok === false ? 'x-circle' : toolIcon(t.name)}
                    size={12}
                    color={t.ok === false ? '#F44336' : colors.primary}
                  />
                  <Text style={styles.toolName}>{t.name}</Text>
                  <Text style={styles.toolDuration}>{formatDuration(t.durationMs)}</Text>
                  <AppIcon name={expandedTool === i ? 'chevron-up' : 'chevron-down'} size={10} color={colors.textMuted} />
                </Pressable>
                {t.args && Object.keys(t.args).length > 0 && (
                  <Text style={styles.toolArgs} numberOfLines={1}>
                    {JSON.stringify(t.args).slice(0, 120)}
                  </Text>
                )}
                {t.result ? (
                  <Text
                    style={[styles.toolResult, t.ok === false && styles.toolResultError]}
                    numberOfLines={expandedTool === i ? undefined : 2}
                  >
                    {expandedTool === i ? t.result : t.result.length > 200 ? `${t.result.slice(0, 200)}…` : t.result}
                  </Text>
                ) : null}
              </Animated.View>
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
                <AppIcon name="file-pen" size={11} color={colors.success} />
                <Text style={styles.fileName}>{f}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>

      {/* 任务完成弹窗 */}
      <CompletionToast show={task.status === 'done'} colors={colors} />
    </Animated.View>
  );
}

const createStyles = (colors: ThemeColors, isDark: boolean) => StyleSheet.create({
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
    color: '#555555',
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
  reviewCard: {
    borderColor: isDark ? 'rgba(85,85,85,0.5)' : 'rgba(58,58,58,0.25)',
  },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  reviewTitle: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  reviewGrid: {
    flexDirection: 'row',
    marginVertical: 4,
  },
  reviewCell: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  reviewNum: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  reviewLabel: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  reviewAdvice: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    lineHeight: 16,
    marginTop: 4,
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
    color: '#F44336',
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
