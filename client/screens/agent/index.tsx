import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  Keyboard,
} from 'react-native';
import EventSource from 'react-native-sse';
import { Audio } from 'expo-av';
import * as Speech from 'expo-speech';
import { Screen } from '@/components/Screen';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MenuButton } from '@/components/Sidebar';

import { getApiBase } from '@/utils';
const API_BASE = getApiBase();
import { FontAwesome6 } from '@expo/vector-icons';
import { colors, spacing, radius, fontSize } from '@/utils/theme';


interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
}

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

interface AgentScreenProps {
  onOpenSidebar: () => void;
}

export default function AgentScreen({ onOpenSidebar }: AgentScreenProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [currentToolCalls, setCurrentToolCalls] = useState<ToolCall[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const insets = useSafeAreaInsets();
  const [keyboardShown, setKeyboardShown] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const esRef = useRef<EventSource | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);

  // Fetch balance function
  const fetchBalance = async () => {
    try {
      /**
       * Server file: server/src/routes/balance.ts
       * API: GET /api/v1/balance
       * Response: { balance: number, available: boolean }
       */
      const response = await fetch(`${API_BASE}/api/v1/balance`);
      const data = await response.json();
      if (data.available) {
        setBalance(data.balance);
      }
    } catch {
      // Balance fetch failed, ignore
    }
  };

  // Fetch balance on mount
  useEffect(() => {
    const loadBalance = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/v1/balance`);
        const data = await response.json();
        if (data.available) {
          setBalance(data.balance);
        }
      } catch {
        // Balance fetch failed, ignore
      }
    };
    loadBalance();
  }, []);

  // Track keyboard visibility so the input area can extend to the bottom edge
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(showEvent, () => setKeyboardShown(true));
    const s2 = Keyboard.addListener(hideEvent, () => setKeyboardShown(false));
    return () => {
      s1.remove();
      s2.remove();
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (esRef.current) {
        esRef.current.close();
      }
    };
  }, []);

  const handleSend = useCallback(() => {
    if (!inputText.trim() || isStreaming) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputText.trim(),
      timestamp: Date.now(),
    };

    // Build conversation history for the API
    const conversationHistory = [
      { role: 'system' as const, content: 'You are Synaps, an AI software development agent running on a mobile phone. You help users develop, debug, build and release software through natural language. Be concise, technical, and action-oriented. When the user describes a task, break it down into steps and execute them. Respond in the same language the user uses.' },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: inputText.trim() },
    ];

    setMessages((prev) => [...prev, userMessage]);
    setInputText('');
    setIsStreaming(true);
    setStreamingContent('');
    setCurrentToolCalls([]);

    /**
     * Server file: server/src/routes/chat.ts
     * API: POST /api/v1/chat
     * Body: { messages: Array<{ role: string, content: string }> }
     * Response: SSE stream with data: {"content": "..."} chunks, ending with data: [DONE]
     */
    const es = new EventSource(
      `${API_BASE}/api/v1/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: conversationHistory }),
        pollingInterval: 0,
      }
    );
    esRef.current = es;

    let accumulated = '';

    es.addEventListener('message', (event) => {
      if (event.data === '[DONE]') {
        // Finalize the assistant message
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: accumulated,
          timestamp: Date.now(),
          toolCalls: currentToolCalls.length > 0 ? currentToolCalls : undefined,
        };
        setMessages((prev) => [...prev, assistantMessage]);
        setStreamingContent('');
        setIsStreaming(false);
        setCurrentToolCalls([]);
        es.close();
        esRef.current = null;
        // Refresh balance after conversation
        fetchBalance();
        return;
      }

      try {
        if (!event.data) return;
        const parsed = JSON.parse(event.data);
        if (parsed.content) {
          accumulated += parsed.content;
          setStreamingContent(accumulated);
        }
        if (parsed.tool_call) {
          setCurrentToolCalls((prev) => [...prev, parsed.tool_call]);
        }
        if (parsed.error) {
          accumulated += `\n\nError: ${parsed.error}`;
          setStreamingContent(accumulated);
        }
      } catch {
        // Ignore parse errors for non-JSON data
      }
    });

    es.addEventListener('error', () => {
      if (accumulated) {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: accumulated + '\n\n[Connection interrupted]',
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } else {
        const errorMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: 'Connection failed. Please check if the backend service is running.',
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      }
      setStreamingContent('');
      setIsStreaming(false);
      setCurrentToolCalls([]);
      es.close();
      esRef.current = null;
    });
  }, [inputText, isStreaming, messages, currentToolCalls]);

  // Voice recording functions
  const startRecording = async () => {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Microphone permission is needed for voice input');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      setIsRecording(true);
    } catch (err) {
      console.error('Failed to start recording', err);
    }
  };

  const stopRecording = async () => {
    if (!recordingRef.current) return;

    try {
      await recordingRef.current.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      setIsRecording(false);

      if (uri) {
        // Send to backend for transcription
        const formData = new FormData();
        formData.append('audio', {
          uri,
          type: 'audio/m4a',
          name: 'recording.m4a',
        } as unknown as Blob);

        /**
         * Server file: server/src/routes/transcribe.ts
         * API: POST /api/v1/transcribe
         * Body: FormData with audio file
         * Response: { text: string }
         */
        const response = await fetch(`${API_BASE}/api/v1/transcribe`, {
          method: 'POST',
          body: formData,
        });
        const data = await response.json();
        if (data.text) {
          setInputText(data.text);
        }
      }
    } catch (err) {
      console.error('Failed to stop recording', err);
      setIsRecording(false);
    }
  };

  // Text-to-speech for AI responses
  const speakMessage = useCallback(async (text: string) => {
    const isSpeaking = await Speech.isSpeakingAsync();
    if (isSpeaking) {
      Speech.stop();
      return;
    }
    Speech.speak(text, {
      language: 'zh-CN',
      pitch: 1.0,
      rate: 1.0,
    });
  }, []);

  const renderMessage = useCallback(({ item }: { item: Message }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        <View style={styles.messageHeader}>
          <View style={[styles.avatarIcon, isUser ? styles.userAvatar : styles.botAvatar]}>
            <FontAwesome6
              name={isUser ? 'user' : 'robot'}
              size={12}
              color={isUser ? colors.textPrimary : colors.primary}
            />
          </View>
          <Text style={styles.messageRole}>{isUser ? 'YOU' : 'SYNAPS'}</Text>
        </View>
        <Text style={styles.messageContent}>{item.content}</Text>
        {item.toolCalls && item.toolCalls.length > 0 && (
          <View style={styles.toolCallsContainer}>
            <Text style={styles.toolCallsLabel}>Tools executed:</Text>
            {item.toolCalls.map((tc, idx) => (
              <View key={idx} style={styles.toolCallItem}>
                <View style={styles.toolCallHeader}>
                  <FontAwesome6 name="terminal" size={10} color={colors.primary} />
                  <Text style={styles.toolCallName}>{tc.name}</Text>
                  {tc.result && (
                    <FontAwesome6 name="circle-check" size={10} color="#4ade80" />
                  )}
                </View>
                {tc.args && Object.keys(tc.args).length > 0 && (
                  <Text style={styles.toolCallArgs} numberOfLines={2}>
                    {JSON.stringify(tc.args).slice(0, 100)}
                  </Text>
                )}
              </View>
            ))}
          </View>
        )}
      </View>
    );
  }, []);

  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle="light" safeAreaEdges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={styles.header}>
          <MenuButton onPress={onOpenSidebar} />
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>Agent</Text>
            <View style={styles.statusBadge}>
              <View style={[styles.statusDot, isStreaming && styles.statusDotStreaming]} />
              <Text style={[styles.statusText, isStreaming && styles.statusTextStreaming]}>
                {isStreaming ? 'THINKING' : 'READY'}
              </Text>
            </View>
          </View>
          <View style={styles.headerRight}>
            {balance !== null && (
              <View style={styles.balanceBadge}>
                <FontAwesome6 name="coins" size={10} color={colors.primary} />
                <Text style={styles.balanceText}>${balance.toFixed(2)}</Text>
              </View>
            )}
            <Pressable style={styles.headerAction}>
              <FontAwesome6 name="ellipsis" size={16} color={colors.textSecondary} />
            </Pressable>
          </View>
        </View>

        {/* Messages */}
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={(item) => item.id}
          style={styles.messageList}
          contentContainerStyle={styles.messageContentArea}
          onContentSizeChange={() => {
            flatListRef.current?.scrollToEnd({ animated: true });
          }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <View style={styles.emptyLogo}>
                <FontAwesome6 name="bolt" size={28} color={colors.primary} />
              </View>
              <Text style={styles.emptyTitle}>SYNAPS AGENT</Text>
              <Text style={styles.emptyDesc}>
                Describe your development task{'\n'}I will help you build it
              </Text>
            </View>
          }
          ListFooterComponent={
            isStreaming && streamingContent ? (
              <View style={[styles.messageBubble, styles.assistantBubble]}>
                <View style={styles.messageHeader}>
                  <View style={[styles.avatarIcon, styles.botAvatar]}>
                    <FontAwesome6 name="robot" size={12} color={colors.primary} />
                  </View>
                  <Text style={styles.messageRole}>SYNAPS</Text>
                </View>
                <Text style={styles.messageContent}>{streamingContent}</Text>
                {currentToolCalls.length > 0 && (
                  <View style={styles.toolCallsContainer}>
                    {currentToolCalls.map((tc, idx) => (
                      <View key={idx} style={styles.toolCallBadge}>
                        <ActivityIndicator size="small" color={colors.primary} />
                        <Text style={styles.toolCallText}>{tc.name}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ) : null
          }
        />

        {/* Input */}
        <View style={[styles.inputContainer, { paddingBottom: keyboardShown ? spacing.lg : spacing.lg + insets.bottom }]}>
          <View style={styles.inputWrapper}>
            <TextInput
              style={styles.textInput}
              placeholder="Describe your development task..."
              placeholderTextColor={colors.textMuted}
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxLength={2000}
              editable={!isStreaming && !isRecording}
              returnKeyType="default"
              blurOnSubmit={false}
            />
            <Pressable
              style={[styles.voiceButton, isRecording && styles.voiceButtonActive]}
              onPress={isRecording ? stopRecording : startRecording}
              disabled={isStreaming}
            >
              <FontAwesome6
                name={isRecording ? 'stop' : 'microphone'}
                size={14}
                color={isRecording ? colors.error : colors.textSecondary}
              />
            </Pressable>
            <Pressable
              style={[styles.sendButton, (!inputText.trim() || isStreaming) && styles.sendButtonDisabled]}
              onPress={handleSend}
              disabled={!inputText.trim() || isStreaming}
            >
              <FontAwesome6
                name={isStreaming ? 'spinner' : 'paper-plane'}
                size={14}
                color={(!inputText.trim() || isStreaming) ? colors.textMuted : colors.primary}
                spin={isStreaming}
              />
            </Pressable>
          </View>
          <View style={styles.inputFooter}>
            <Pressable onPress={() => setAutoSpeak(!autoSpeak)} style={styles.autoSpeakToggle}>
              <FontAwesome6
                name={autoSpeak ? 'volume-high' : 'volume-xmark'}
                size={12}
                color={autoSpeak ? colors.primary : colors.textMuted}
              />
              <Text style={[styles.autoSpeakText, autoSpeak && styles.autoSpeakTextActive]}>
                {autoSpeak ? 'Auto-speak ON' : 'Auto-speak OFF'}
              </Text>
            </Pressable>
            {isRecording && (
              <View style={styles.recordingIndicator}>
                <View style={styles.recordingDot} />
                <Text style={styles.recordingText}>Recording...</Text>
              </View>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  statusDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  statusDotStreaming: {
    backgroundColor: colors.primary,
  },
  statusText: {
    fontSize: fontSize.xs,
    color: colors.success,
    letterSpacing: 1.5,
    fontWeight: '600',
  },
  statusTextStreaming: {
    color: colors.primary,
  },
  balanceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  balanceText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  headerAction: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageList: {
    flex: 1,
  },
  messageContentArea: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  messageBubble: {
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    marginTop: spacing.sm,
  },
  userBubble: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    marginLeft: 40,
  },
  assistantBubble: {
    backgroundColor: 'rgba(167,139,250,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(167,139,250,0.15)',
    marginRight: 40,
  },
  messageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  avatarIcon: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userAvatar: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  botAvatar: {
    backgroundColor: 'rgba(167,139,250,0.15)',
  },
  messageRole: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 1.5,
  },
  messageContent: {
    fontSize: fontSize.md,
    color: colors.textPrimary,
    lineHeight: 22,
  },
  toolCallsContainer: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: 'rgba(167,139,250,0.1)',
    gap: spacing.sm,
  },
  toolCallsLabel: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  toolCallItem: {
    backgroundColor: 'rgba(167,139,250,0.05)',
    borderRadius: radius.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(167,139,250,0.15)',
  },
  toolCallHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  toolCallName: {
    fontSize: fontSize.xs,
    color: colors.primary,
    fontWeight: '600',
    flex: 1,
  },
  toolCallArgs: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  toolCallBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    backgroundColor: 'rgba(167,139,250,0.1)',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(167,139,250,0.2)',
  },
  toolCallText: {
    fontSize: fontSize.xs,
    color: colors.primary,
    fontWeight: '500',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  emptyLogo: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primaryGlow,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: 3,
    marginBottom: spacing.sm,
  },
  emptyDesc: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  inputContainer: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgRoot,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 2,
  },
  textInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fontSize.md,
    paddingVertical: spacing.md,
    maxHeight: 120,
    minHeight: 44,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primaryGlow,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
    marginLeft: spacing.sm,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  inputHint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  voiceButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
    marginLeft: spacing.sm,
  },
  voiceButtonActive: {
    backgroundColor: 'rgba(239,68,68,0.15)',
    borderWidth: 1,
    borderColor: colors.error,
  },
  inputFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  autoSpeakToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  autoSpeakText: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  autoSpeakTextActive: {
    color: colors.primary,
  },
  recordingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  recordingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.error,
  },
  recordingText: {
    fontSize: fontSize.xs,
    color: colors.error,
    fontWeight: '600',
  },
});
