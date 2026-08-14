import React, { useState, useRef } from 'react';
import { View, Text, StyleSheet, TextInput, ScrollView, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { Screen } from '@/components/Screen';
import { MenuButton } from '@/components/Sidebar';

import { getApiBase } from '@/utils';
const API_BASE = getApiBase();
import { FontAwesome6 } from '@expo/vector-icons';
import { colors, spacing, radius, fontSize } from '@/utils/theme';

interface TerminalScreenProps {
  onOpenSidebar: () => void;
}

interface CommandResult {
  id: string;
  command: string;
  output: string;
  error: string;
  exitCode: number | null;
  duration: number;
  timestamp: Date;
}


export default function TerminalScreen({ onOpenSidebar }: TerminalScreenProps) {
  const [command, setCommand] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [history, setHistory] = useState<CommandResult[]>([]);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const scrollViewRef = useRef<ScrollView>(null);

  const executeCommand = async () => {
    if (!command.trim() || isExecuting) return;

    const cmd = command.trim();
    setCommand('');
    setIsExecuting(true);
    setCommandHistory(prev => [cmd, ...prev.slice(0, 49)]);
    setHistoryIndex(-1);

    const startTime = Date.now();

    try {
      /**
       * 服务端文件：server/src/routes/terminal.ts
       * 接口：POST /api/v1/terminal/exec
       * Body 参数：command: string, cwd?: string
       */
      const response = await fetch(`${API_BASE}/api/v1/terminal/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });

      const data = await response.json();
      const duration = Date.now() - startTime;

      const result: CommandResult = {
        id: Date.now().toString(),
        command: cmd,
        output: data.stdout || '',
        error: data.stderr || '',
        exitCode: data.exitCode,
        duration,
        timestamp: new Date(),
      };

      setHistory(prev => [...prev, result]);
    } catch (error) {
      const duration = Date.now() - startTime;
      const result: CommandResult = {
        id: Date.now().toString(),
        command: cmd,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error',
        exitCode: -1,
        duration,
        timestamp: new Date(),
      };
      setHistory(prev => [...prev, result]);
    } finally {
      setIsExecuting(false);
      setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  const navigateHistory = (direction: 'up' | 'down') => {
    if (commandHistory.length === 0) return;

    let newIndex: number;
    if (direction === 'up') {
      newIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
    } else {
      newIndex = Math.max(historyIndex - 1, -1);
    }

    setHistoryIndex(newIndex);
    if (newIndex >= 0) {
      setCommand(commandHistory[newIndex]);
    } else {
      setCommand('');
    }
  };

  const clearHistory = () => {
    setHistory([]);
  };

  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle="light">
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={styles.header}>
          <MenuButton onPress={onOpenSidebar} />
          <Text style={styles.headerTitle}>终端</Text>
          <TouchableOpacity onPress={clearHistory} style={styles.clearButton}>
            <FontAwesome6 name="trash" size={14} color={colors.textMuted} />
          </TouchableOpacity>
          <View style={styles.terminalBadge}>
            <View style={[styles.badgeDot, { backgroundColor: colors.success }]} />
            <Text style={styles.badgeText}>CONNECTED</Text>
          </View>
        </View>

        {/* Terminal Area */}
        <View style={styles.terminalWindow}>
          <View style={styles.terminalBar}>
            <View style={styles.terminalDots}>
              <View style={[styles.dot, { backgroundColor: colors.error }]} />
              <View style={[styles.dot, { backgroundColor: colors.warning }]} />
              <View style={[styles.dot, { backgroundColor: colors.success }]} />
            </View>
            <Text style={styles.terminalTitle}>synaps-terminal</Text>
          </View>

          <ScrollView
            ref={scrollViewRef}
            style={styles.terminalBody}
            contentContainerStyle={styles.terminalContent}
            showsVerticalScrollIndicator={false}
          >
            {history.length === 0 && (
              <View style={styles.emptyState}>
                <FontAwesome6 name="terminal" size={32} color={colors.textMuted} />
                <Text style={styles.emptyText}>Synaps Terminal</Text>
                <Text style={styles.emptySubtext}>输入命令开始执行</Text>
              </View>
            )}

            {history.map((item) => (
              <View key={item.id} style={styles.commandBlock}>
                <View style={styles.commandLine}>
                  <Text style={styles.prompt}>synaps@device</Text>
                  <Text style={styles.at}>:</Text>
                  <Text style={styles.path}>~</Text>
                  <Text style={styles.dollar}>$ </Text>
                  <Text style={styles.commandText}>{item.command}</Text>
                </View>
                {item.output ? (
                  <Text style={styles.outputText}>{item.output}</Text>
                ) : null}
                {item.error ? (
                  <Text style={styles.errorText}>{item.error}</Text>
                ) : null}
                <View style={styles.resultInfo}>
                  <Text style={[
                    styles.exitCode,
                    { color: item.exitCode === 0 ? colors.success : colors.error }
                  ]}>
                    [{item.exitCode}]
                  </Text>
                  <Text style={styles.duration}>{item.duration}ms</Text>
                </View>
              </View>
            ))}

            {isExecuting && (
              <View style={styles.executingLine}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.executingText}> 执行中...</Text>
              </View>
            )}
          </ScrollView>
        </View>

        {/* Input Area */}
        <View style={styles.inputContainer}>
          <Text style={styles.inputPrompt}>$</Text>
          <TextInput
            style={styles.input}
            value={command}
            onChangeText={setCommand}
            placeholder="输入命令..."
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isExecuting}
            onSubmitEditing={executeCommand}
          />
          <TouchableOpacity
            style={[styles.executeButton, isExecuting && styles.executeButtonDisabled]}
            onPress={executeCommand}
            disabled={isExecuting || !command.trim()}
          >
            {isExecuting ? (
              <ActivityIndicator size="small" color={colors.textPrimary} />
            ) : (
              <FontAwesome6 name="play" size={14} color={colors.textPrimary} />
            )}
          </TouchableOpacity>
        </View>

        {/* Status Bar */}
        <View style={styles.statusBar}>
          <View style={styles.statusItem}>
            <View style={[styles.statusIndicator, { backgroundColor: colors.success }]} />
            <Text style={styles.statusLabel}>READY</Text>
          </View>
          <Text style={styles.statusInfo}>{history.length} commands executed</Text>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  headerTitle: {
    flex: 1,
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  clearButton: {
    padding: spacing.xs,
  },
  terminalBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  badgeDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: fontSize.xs,
    color: colors.success,
    fontWeight: '600',
  },
  terminalWindow: {
    flex: 1,
    backgroundColor: '#0A0A0F',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    overflow: 'hidden',
  },
  terminalBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  terminalDots: {
    flexDirection: 'row',
    gap: 6,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  terminalTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: fontSize.xs,
    color: colors.textMuted,
    fontWeight: '500',
  },
  terminalBody: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  terminalContent: {
    flexGrow: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl * 2,
  },
  emptyText: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  emptySubtext: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
  },
  commandBlock: {
    marginBottom: spacing.md,
  },
  commandLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 4,
  },
  prompt: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  at: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  path: {
    color: colors.info,
    fontSize: fontSize.sm,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  dollar: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  commandText: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  outputText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
    lineHeight: 20,
  },
  errorText: {
    color: colors.error,
    fontSize: fontSize.sm,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
    lineHeight: 20,
  },
  resultInfo: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: 4,
  },
  exitCode: {
    fontSize: fontSize.xs,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  duration: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  executingLine: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  executingText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.md,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: spacing.md,
  },
  inputPrompt: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: '700',
    marginRight: spacing.sm,
  },
  input: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    paddingVertical: spacing.md,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  executeButton: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  executeButtonDisabled: {
    opacity: 0.5,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  statusItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusIndicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusLabel: {
    fontSize: fontSize.xs,
    color: colors.success,
    fontWeight: '600',
  },
  statusInfo: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
});
