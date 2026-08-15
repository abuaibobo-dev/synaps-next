import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  TouchableOpacity,
  Animated,
  Keyboard,
  Platform,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { MenuButton } from '@/components/Sidebar';

import { getApiBase } from '@/utils';
const API_BASE = getApiBase();
import { FontAwesome6 } from '@expo/vector-icons';
import { spacing } from '@/utils/theme';

// 黑客风（矩阵绿 / 纯黑）
const BG = '#000000';
const GREEN = '#00FF41';
const OUTPUT = '#C0C0C0';
const DIM = '#4A4A4A';
const FAIL = '#FF0044';
const MONO = 'monospace';

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
  const [keyboardShown, setKeyboardShown] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [bottomBarHeight, setBottomBarHeight] = useState(0);

  // 绿色闪烁动画（执行中 / 光标方块）
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.15, duration: 500, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 500, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [blink]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(showEvent, (e) => {
      setKeyboardShown(true);
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
    });
    const s2 = Keyboard.addListener(hideEvent, () => {
      setKeyboardShown(false);
      setKeyboardHeight(0);
    });
    return () => {
      s1.remove();
      s2.remove();
    };
  }, []);

  const executeCommand = async () => {
    if (!command.trim() || isExecuting) return;

    const cmd = command.trim();
    setCommand('');
    setIsExecuting(true);
    setCommandHistory((prev) => [cmd, ...prev.slice(0, 49)]);
    setHistoryIndex(-1);

    const startTime = Date.now();

    try {
      const response = await fetch(`${API_BASE}/api/v1/terminal/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });

      const data = await response.json();
      const duration = Date.now() - startTime;

      if (!response.ok) {
        throw new Error(data.error || `请求失败 (HTTP ${response.status})`);
      }

      const result: CommandResult = {
        id: Date.now().toString(),
        command: cmd,
        output: data.stdout || '',
        error: data.stderr || '',
        exitCode: data.exitCode,
        duration,
        timestamp: new Date(),
      };

      setHistory((prev) => [...prev, result]);
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
      setHistory((prev) => [...prev, result]);
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

  const lastFailed = history.length > 0 && history[history.length - 1].exitCode !== 0;
  const bottomOffset = keyboardShown ? (Platform.OS === 'ios' ? keyboardHeight : 0) : 0;

  return (
    <Screen backgroundColor={BG} statusBarStyle="light" scrollable>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <MenuButton onPress={onOpenSidebar} />
          <Text style={styles.headerTitle}>⚡ TERMINAL</Text>
          <View style={styles.headerSpacer} />
          <TouchableOpacity onPress={clearHistory} style={styles.clearButton} hitSlop={8}>
            <FontAwesome6 name="trash" size={13} color={DIM} />
          </TouchableOpacity>
        </View>

        {/* Terminal Output */}
        <ScrollView
          ref={scrollViewRef}
          style={styles.terminalBody}
          contentContainerStyle={[
            styles.terminalContent,
            { paddingBottom: bottomBarHeight + bottomOffset + spacing.md },
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {history.length === 0 && !isExecuting && (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>SYNAPS TERMINAL</Text>
              <Text style={styles.emptySubtext}>输入命令开始执行</Text>
            </View>
          )}

          {history.map((item) => {
            const ok = item.exitCode === 0;
            return (
              <View key={item.id} style={styles.commandBlock}>
                <Text style={styles.commandLine}>
                  <Text style={styles.prompt}>synaps@device:~$ </Text>
                  <Text style={styles.commandText}>{item.command}</Text>
                </Text>
                {item.output ? <Text style={styles.outputText}>{item.output}</Text> : null}
                {item.error ? <Text style={styles.errorText}>{item.error}</Text> : null}
                <Text style={[styles.resultLine, { color: ok ? GREEN : FAIL }]}>
                  {ok ? '✓ 完成' : '✗ 失败'} ({(item.duration / 1000).toFixed(2)}s)
                </Text>
              </View>
            );
          })}

          {isExecuting && (
            <Animated.View style={[styles.executingLine, { opacity: blink }]}>
              <Text style={styles.executingText}>⏳ 执行中...</Text>
            </Animated.View>
          )}
        </ScrollView>

        {/* Bottom Input */}
        <View
          style={[styles.bottomBar, { bottom: bottomOffset }]}
          onLayout={(e) => setBottomBarHeight(e.nativeEvent.layout.height)}
        >
          <View style={[styles.inputRow, lastFailed && styles.inputRowFailed]}>
            <Text style={styles.inputPrompt}>synaps@device:~$ </Text>
            <TextInput
              style={styles.input}
              value={command}
              onChangeText={setCommand}
              placeholder="输入命令..."
              placeholderTextColor={DIM}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isExecuting}
              onSubmitEditing={executeCommand}
              cursorColor={GREEN}
              selectionColor={GREEN}
            />
            <TouchableOpacity
              style={styles.executeButton}
              onPress={executeCommand}
              disabled={isExecuting || !command.trim()}
              hitSlop={8}
            >
              <Text style={[styles.executeIcon, (isExecuting || !command.trim()) && styles.executeDisabled]}>
                {isExecuting ? '⏳' : '>'}
              </Text>
            </TouchableOpacity>
          </View>
          <View style={styles.statusBar}>
            <Text style={styles.statusLabel}>{isExecuting ? 'RUNNING' : 'READY'}</Text>
            <Text style={styles.statusInfo}>{history.length} commands</Text>
          </View>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BG,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1A1A1A',
  },
  headerSpacer: {
    flex: 1,
  },
  headerTitle: {
    color: GREEN,
    fontSize: 13,
    fontFamily: MONO,
    letterSpacing: 2,
    fontWeight: '700',
  },
  clearButton: {
    padding: 4,
  },
  terminalBody: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  terminalContent: {
    flexGrow: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 80,
  },
  emptyTitle: {
    color: GREEN,
    fontSize: 13,
    fontFamily: MONO,
    letterSpacing: 2,
  },
  emptySubtext: {
    color: DIM,
    fontSize: 13,
    fontFamily: MONO,
  },
  commandBlock: {
    marginBottom: 12,
  },
  commandLine: {
    color: GREEN,
    fontSize: 13,
    fontFamily: MONO,
    lineHeight: 19,
  },
  prompt: {
    color: GREEN,
  },
  commandText: {
    color: GREEN,
  },
  outputText: {
    color: OUTPUT,
    fontSize: 13,
    fontFamily: MONO,
    lineHeight: 19,
    marginTop: 2,
  },
  errorText: {
    color: FAIL,
    fontSize: 13,
    fontFamily: MONO,
    lineHeight: 19,
    marginTop: 2,
  },
  resultLine: {
    fontSize: 13,
    fontFamily: MONO,
    lineHeight: 19,
    marginTop: 4,
  },
  executingLine: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  executingText: {
    color: GREEN,
    fontSize: 13,
    fontFamily: MONO,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: spacing.md,
    backgroundColor: BG,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
    paddingBottom: 4,
  },
  inputRowFailed: {
    borderBottomColor: FAIL,
  },
  inputPrompt: {
    color: GREEN,
    fontSize: 13,
    fontFamily: MONO,
  },
  input: {
    flex: 1,
    color: GREEN,
    fontSize: 13,
    fontFamily: MONO,
    paddingVertical: 8,
    paddingLeft: 0,
  },
  executeButton: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  executeIcon: {
    color: GREEN,
    fontSize: 13,
    fontFamily: MONO,
    fontWeight: '700',
  },
  executeDisabled: {
    color: DIM,
  },
  statusBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 6,
  },
  statusLabel: {
    color: DIM,
    fontSize: 11,
    fontFamily: MONO,
    letterSpacing: 1,
  },
  statusInfo: {
    color: DIM,
    fontSize: 11,
    fontFamily: MONO,
  },
});
