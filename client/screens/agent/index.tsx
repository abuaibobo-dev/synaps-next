import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  FlatList,
  ScrollView,
  Platform,
  Alert,
  Keyboard,
  Modal,
  Share,
  useWindowDimensions,
} from 'react-native';
import EventSource from 'react-native-sse';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import { Audio } from 'expo-av';
import * as Speech from 'expo-speech';
import { Screen } from '@/components/Screen';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MenuButton } from '@/components/Sidebar';

import { getApiBase } from '@/utils';
import { getDeviceStatus, startDeviceBridge } from '@/utils/deviceControl';
import { subscribe } from '@/utils/appBus';
import TaskPanel, { isFileModifyingTool, type TaskRecord, type TaskToolRecord, type TaskStep } from '@/components/TaskPanel';
const API_BASE = getApiBase();
import { FontAwesome6 } from '@expo/vector-icons';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';
import { useThemeColors } from '@/components/ThemeProvider';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  ReduceMotion,
} from 'react-native-reanimated';
import { AppIcon, toolIcon } from '@/components/AppIcon';
import { useEntry, PressableScale, ThinkingDots, ToolSpinner, AnimatedProgressBar, Skeleton } from '@/components/motion';

function PanelToggleIcon({
  open,
  sideBySide,
  color,
}: {
  open: boolean;
  sideBySide: boolean;
  color: string;
}) {
  const rotate = useSharedValue(open ? 180 : 0);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotate.get()}deg` }],
  }));

  useEffect(() => {
    rotate.set(
      withTiming(open ? 180 : 0, {
        duration: 200,
        easing: Easing.inOut(Easing.ease),
        reduceMotion: ReduceMotion.System,
      })
    );
  }, [open, rotate]);

  if (sideBySide) {
    return <AppIcon name="box" size={15} color={color} />;
  }

  return (
    <Animated.View style={animatedStyle}>
      <AppIcon name={open ? 'chevron-down' : 'chevron-up'} size={15} color={color} />
    </Animated.View>
  );
}

export const AGENT_OPTIONS = [
  { key: 'scheduler', label: '调度员', icon: 'sitemap' },
  { key: 'code_engineer', label: '代码工程师', icon: 'code' },
  { key: 'file_manager', label: '文件管理', icon: 'folder' },
  { key: 'search_assistant', label: '搜索', icon: 'magnifying-glass' },
  { key: 'general_chat', label: '通用对话', icon: 'comments' },
  { key: 'automator', label: '自动化', icon: 'gear' },
  { key: 'ui_operator', label: '界面操作', icon: 'hand-pointer' },
  { key: 'researcher', label: '调研', icon: 'flask' },
  { key: 'translator', label: '翻译', icon: 'language' },
  { key: 'memory_admin', label: '记忆管理', icon: 'brain' },
] as const;

export type AgentOptionKey = (typeof AGENT_OPTIONS)[number]['key'];

const MODEL_OPTIONS = ['deepseek-chat', 'deepseek-reasoner'];

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  replyingTo?: { content: string; role: string };
}

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

interface ProjectOption {
  id: string;
  name: string;
  path: string;
}

interface PermissionRequest {
  id: string;
  level: 'medium' | 'high' | 'critical';
  tool: string;
  args: { command?: string; path?: string; query?: string; message?: string; repo?: string; url?: string; server?: string; method?: string };
  impact: string;
}

interface AgentScreenProps {
  onOpenSidebar: () => void;
}

export default function AgentScreen({ onOpenSidebar }: AgentScreenProps) {
  const { colors, isDark } = useThemeColors();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const messageEntry = useEntry('message');
  const cardEntry = useEntry('card');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [currentToolCalls, setCurrentToolCalls] = useState<ToolCall[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [currentModel, setCurrentModel] = useState(MODEL_OPTIONS[0]);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [menuMessage, setMenuMessage] = useState<Message | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [projectPickerVisible, setProjectPickerVisible] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [deviceReady, setDeviceReady] = useState<boolean | null>(null);
  const [currentTask, setCurrentTask] = useState<TaskRecord | null>(null);
  const [taskPanelVisible, setTaskPanelVisible] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [agentType, setAgentType] = useState<AgentOptionKey>('scheduler');
  const [agentInstanceIds, setAgentInstanceIds] = useState<Record<string, string>>({});
  const requestIdRef = useRef<string>('');
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isSideBySide = windowWidth >= 600 && windowWidth > windowHeight * 0.8;
  const insets = useSafeAreaInsets();
  const [keyboardShown, setKeyboardShown] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [inputAreaHeight, setInputAreaHeight] = useState(0);
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

  const fetchProjectOptions = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects`);
      const data = await response.json();
      setProjectOptions(data.projects || []);
    } catch {
      // Keep existing list
    }
  }, []);

  // Load current model from server settings so the switch reflects the real value
  useEffect(() => {
    (async () => {
      try {
        const response = await fetch(`${API_BASE}/api/v1/settings`);
        const data = await response.json();
        if (data && typeof data.ai_model === 'string' && data.ai_model) {
          setCurrentModel(data.ai_model);
        }
        if (data && typeof data.current_project_id === 'string' && data.current_project_id) {
          setCurrentProjectId(data.current_project_id);
        }
      } catch {
        // Settings unavailable, keep default model
      }
      fetchProjectOptions();
    })();
  }, [fetchProjectOptions]);

  // Load conversation history from backend
  const loadHistory = useCallback(async (projectId: string | null) => {
    try {
      const url = projectId
        ? `${API_BASE}/api/v1/chat/history?project_id=${encodeURIComponent(projectId)}`
        : `${API_BASE}/api/v1/chat/history`;
      const response = await fetch(url);
      if (!response.ok) return;
      const data = await response.json();
      const msgs: Message[] = (data.messages || []).map(
        (m: { id: string; role: string; content: string; created_at: string }) => ({
          id: m.id || `${m.created_at}-${m.role}`,
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
          timestamp: new Date(m.created_at + 'Z').getTime(),
        })
      );
      setMessages(msgs);
    } catch {
      // History unavailable, start fresh
    }
  }, []);

  // 加载当前项目的 Agent 实例，并加载当前 Agent 的独立历史
  const loadAgents = useCallback(async (projectId: string | null) => {
    try {
      const url = projectId
        ? `${API_BASE}/api/v1/chat/agents?projectId=${encodeURIComponent(projectId)}`
        : `${API_BASE}/api/v1/chat/agents`;
      const response = await fetch(url);
      if (!response.ok) return;
      const data = await response.json();
      const map: Record<string, string> = {};
      for (const a of data.agents || []) {
        if (a && typeof a.type === 'string' && typeof a.id === 'string') map[a.type] = a.id;
      }
      setAgentInstanceIds(map);
    } catch {
      // 忽略：后端未就绪时静默重试
    }
  }, []);

  const loadAgentHistory = useCallback(async (type: string, instanceId?: string) => {
    if (!instanceId) {
      setMessages([]);
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/v1/chat/agent-history?agentInstanceId=${encodeURIComponent(instanceId)}`);
      if (!response.ok) return;
      const data = await response.json();
      const msgs: Message[] = (data.messages || []).map(
        (m: { id: string; role: string; content: string; created_at: string }) => ({
          id: m.id || `${m.created_at}-${m.role}`,
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
          timestamp: new Date(m.created_at + 'Z').getTime(),
        })
      );
      setMessages(msgs);
    } catch {
      // 忽略
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadAgents(currentProjectId);
      await loadAgentHistory(agentType, agentInstanceIds[agentType]);
      setInitialLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId, agentType]);

  // 侧栏「最近项目」点击切换项目时同步当前项目
  useEffect(() => {
    return subscribe('project:changed', (project: ProjectOption) => {
      setCurrentProjectId(project.id);
    });
  }, []);

  const switchAgent = useCallback((type: AgentOptionKey) => {
    setAgentType(type);
    loadAgentHistory(type, agentInstanceIds[type]);
  }, [agentInstanceIds, loadAgentHistory]);

  // Track keyboard visibility so the input area can extend to the bottom edge
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

  // 设备控制桥：启动轮询，把后端队列里的设备动作交给原生无障碍服务执行
  useEffect(() => {
    const stop = startDeviceBridge();
    getDeviceStatus()
      .then((st) => setDeviceReady(st.enabled && st.serviceConnected))
      .catch(() => setDeviceReady(false));
    const timer = setInterval(() => {
      getDeviceStatus()
        .then((st) => setDeviceReady(st.enabled && st.serviceConnected))
        .catch(() => setDeviceReady(false));
    }, 5000);
    return () => {
      stop();
      clearInterval(timer);
      if (esRef.current) {
        esRef.current.close();
      }
    };
  }, []);

  const switchModel = useCallback(async () => {
    const idx = MODEL_OPTIONS.indexOf(currentModel);
    const next = MODEL_OPTIONS[(idx + 1) % MODEL_OPTIONS.length];
    setCurrentModel(next);
    try {
      await fetch(`${API_BASE}/api/v1/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai_model: next }),
      });
    } catch {
      // Persistence failed; this session still uses the new model
    }
  }, [currentModel]);

  const openProjectPicker = useCallback(async () => {
    await fetchProjectOptions();
    setProjectPickerVisible(true);
  }, [fetchProjectOptions]);

  const selectProject = useCallback(async (project: ProjectOption) => {
    setCurrentProjectId(project.id);
    setProjectPickerVisible(false);
    try {
      await fetch(`${API_BASE}/api/v1/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_project_id: project.id }),
      });
    } catch {
      // Persistence failed; this session still uses the project
    }
  }, []);

  const startTask = useCallback((prompt: string) => {
    if (!prompt.trim() || isStreaming) return;

    const requestId = `task-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    requestIdRef.current = requestId;

    // 创建任务记录
    const task: TaskRecord = {
      id: requestId,
      name: prompt.replace(/\n/g, ' ').slice(0, 60),
      prompt,
      startedAt: Date.now(),
      status: 'running',
      steps: [],
      tools: [],
      files: [],
    };
    setCurrentTask(task);

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
      replyingTo: replyingTo
        ? { content: replyingTo.content, role: replyingTo.role }
        : undefined,
    };

    // Build conversation history for the API
    const conversationHistory = [
      { role: 'system' as const, content: 'You are Synaps, an AI software development agent running on a mobile phone. You help users develop, debug, build and release software through natural language. Be concise, technical, and action-oriented. When the user describes a task, break it down into steps and execute them. Respond in the same language the user uses.' },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: prompt },
    ];

    setMessages((prev) => [...prev, userMessage]);
    setInputText('');
    setReplyingTo(null);
    setIsStreaming(true);
    setStreamingContent('');
    setCurrentToolCalls([]);

    /**
     * Server file: server/src/routes/chat.ts
     * API: POST /api/v1/chat
     * Body: { messages, projectId, requestId }
     * Response: SSE stream: {content}, {tool_call}, {task_start}, {task_step}, {task_end}, [DONE]
     */
    const es = new EventSource(
      `${API_BASE}/api/v1/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: conversationHistory,
          projectId: currentProjectId,
          requestId,
          agentType,
          agentInstanceId: agentInstanceIds[agentType] || undefined,
        }),
        pollingInterval: 0,
      }
    );
    esRef.current = es;

    let accumulated = '';
    const executedToolCalls: ToolCall[] = [];

    const patchTask = (fn: (t: TaskRecord) => TaskRecord) => {
      setCurrentTask((prev) => (prev && prev.id === requestId ? fn(prev) : prev));
    };

    es.addEventListener('message', (event) => {
      if (event.data === '[DONE]') {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: accumulated,
          timestamp: Date.now(),
          toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined,
        };
        setMessages((prev) => [...prev, assistantMessage]);
        setStreamingContent('');
        setIsStreaming(false);
        setCurrentToolCalls([]);
        patchTask((t) => ({ ...t, status: t.status === 'running' ? 'done' : t.status, endedAt: Date.now() }));
        es.close();
        esRef.current = null;
        fetchBalance();
        return;
      }

      try {
        if (!event.data) return;
        const parsed = JSON.parse(event.data);

        if (parsed.task_start) {
          if (parsed.task_start.agent && parsed.task_start.agent.id && parsed.task_start.agent.type) {
            setAgentInstanceIds((prev) => ({ ...prev, [parsed.task_start.agent.type]: parsed.task_start.agent.id }));
          }
          setCurrentTask((prev) =>
            prev && prev.id === parsed.task_start.id
              ? prev
              : { id: parsed.task_start.id, name: parsed.task_start.name, prompt, startedAt: parsed.task_start.startedAt, status: 'running', steps: [], tools: [], files: [] }
          );
        }
        if (parsed.task_step) {
          const step: TaskStep = { name: parsed.task_step.step, status: parsed.task_step.status };
          patchTask((t) => {
            const steps = [...t.steps];
            if (parsed.task_step.status === 'running') {
              steps.push(step);
            } else {
              const lastIdx = [...steps].reverse().findIndex((s) => s.name === step.name && s.status === 'running');
              if (lastIdx !== -1) steps[steps.length - 1 - lastIdx] = step;
              else steps.push(step);
            }
            return { ...t, steps };
          });
        }
        if (parsed.tool_call) {
          const rec = parsed.tool_call as TaskToolRecord;
          executedToolCalls.push(rec as unknown as ToolCall);
          setCurrentToolCalls((prev) => [...prev, rec as unknown as ToolCall]);
          patchTask((t) => {
            const tools = [...t.tools, { ...rec, ts: Date.now() }];
            const files = new Set(t.files);
            if (isFileModifyingTool(rec.name, (rec.args || {}) as Record<string, unknown>)) {
              const argPath = (rec.args as Record<string, unknown>)?.path;
              if (typeof argPath === 'string' && argPath) files.add(argPath);
            }
            return { ...t, tools, files: [...files] };
          });
        }
        if (parsed.task_end) {
          patchTask((t) => ({ ...t, status: parsed.task_end.status || 'done', endedAt: Date.now() }));
        }
        if (parsed.content) {
          accumulated += parsed.content;
          setStreamingContent(accumulated);
        }
        if (parsed.permission_request) {
          setPermissionRequest(parsed.permission_request as PermissionRequest);
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
      patchTask((t) => ({ ...t, status: 'error', endedAt: Date.now() }));
      es.close();
      esRef.current = null;
    });
  }, [inputText, isStreaming, messages, replyingTo, currentProjectId, agentType, agentInstanceIds]);

  const handleSend = useCallback(() => {
    if (!inputText.trim() || isStreaming) return;
    const quotedText = replyingTo
      ? `> ${replyingTo.content.replace(/\n/g, '\n> ')}\n\n`
      : '';
    startTask(`${quotedText}${inputText.trim()}`);
  }, [inputText, isStreaming, replyingTo, startTask]);

  // 取消当前任务
  const cancelTask = useCallback(() => {
    const requestId = requestIdRef.current;
    if (!requestId) return;
    fetch(`${API_BASE}/api/v1/chat/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    }).catch(() => undefined);
    if (esRef.current) esRef.current.close();
    setCurrentTask((t) => (t ? { ...t, status: 'cancelled', endedAt: Date.now() } : t));
    setIsStreaming(false);
    setStreamingContent('');
    esRef.current = null;
  }, []);

  // 重跑：以相同指令重新发起任务
  const rerunTask = useCallback(() => {
    const task = currentTask;
    if (!task) return;
    startTask(task.prompt);
  }, [currentTask, startTask]);

  // 回滚：恢复任务开始前的最新快照，并向对话流插入回滚记录
  const rollbackTask = useCallback(async () => {
    const task = currentTask;
    if (!task || !currentProjectId) return;
    try {
      const listRes = await fetch(`${API_BASE}/api/v1/snapshots/list?projectId=${currentProjectId}`);
      const listData = await listRes.json();
      const snaps = Array.isArray(listData.snapshots) ? listData.snapshots : [];
      if (snaps.length === 0) {
        alert('没有可用快照');
        return;
      }
      const latest = snaps[snaps.length - 1] || snaps[0];
      const res = await fetch(`${API_BASE}/api/v1/snapshots/${latest.id}/restore`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const rollbackMsg: Message = {
          id: Date.now().toString(),
          role: 'assistant',
          content: `[已回滚] 已恢复到快照「${latest.label || latest.id}」（${new Date(latest.created_at).toLocaleString()}）`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, rollbackMsg]);
        alert('已恢复到任务前快照');
      } else {
        alert(data.error || '回滚失败');
      }
    } catch {
      alert('回滚失败');
    }
  }, [currentTask, currentProjectId]);

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

  const closeMessageMenu = useCallback(() => {
    setMenuMessage(null);
  }, []);

  const openMessageMenu = useCallback((message: Message) => {
    setMenuMessage(message);
  }, []);

  const copyMessage = useCallback(
    async (message: Message) => {
      await Clipboard.setStringAsync(message.content);
      closeMessageMenu();
      Toast.show({ type: 'success', text1: '已复制到剪贴板' });
    },
    [closeMessageMenu]
  );

  const quoteMessage = useCallback(
    (message: Message) => {
      setReplyingTo(message);
      closeMessageMenu();
    },
    [closeMessageMenu]
  );

  const shareMessage = useCallback(
    async (message: Message) => {
      try {
        await Share.share({ message: message.content });
      } catch {
        // User dismissed the share sheet
      }
      closeMessageMenu();
    },
    [closeMessageMenu]
  );

  const respondPermission = useCallback(
    async (approved: boolean) => {
      if (!permissionRequest) return;
      const request = permissionRequest;
      setPermissionRequest(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/chat/approval`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: request.id, approved }),
        });
        if (!res.ok) {
          Toast.show({ type: 'error', text1: '审批已过期，请重试' });
        }
      } catch {
        Toast.show({ type: 'error', text1: '审批提交失败' });
      }
    },
    [permissionRequest]
  );

  const renderMessage = useCallback(({ item }: { item: Message }) => {
    const isUser = item.role === 'user';
    return (
      <Animated.View {...messageEntry} style={[styles.messageRow, isUser ? styles.messageRowUser : styles.messageRowAssistant]}>
      <Pressable
        onLongPress={() => openMessageMenu(item)}
        delayLongPress={350}
        style={styles.messageRowInner}
      >
        <View style={[styles.avatarCircle, isUser ? styles.avatarUser : styles.avatarBot]}>
          <FontAwesome6
            name={isUser ? 'user' : 'robot'}
            size={14}
            color={isUser ? '#FFFFFF' : colors.primary}
          />
        </View>
        <View style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}>
          {item.replyingTo && (
            <View style={[styles.replyPreview, isUser && styles.replyPreviewUser]}>
              <Text style={[styles.replyPreviewLabel, isUser && styles.replyPreviewLabelUser]}>
                {item.replyingTo.role === 'user' ? 'YOU' : 'SYNAPS'}
              </Text>
              <Text
                style={[styles.replyPreviewText, isUser && styles.replyPreviewTextUser]}
                numberOfLines={2}
              >
                {item.replyingTo.content}
              </Text>
            </View>
          )}
          <Text style={[styles.messageContent, isUser && styles.messageContentUser]}>
            {item.content}
          </Text>
          {item.toolCalls && item.toolCalls.length > 0 && (
            <View style={styles.toolCallsContainer}>
              <Text style={styles.toolCallsLabel}>Tools executed:</Text>
              {item.toolCalls.map((tc, idx) => {
                const command =
                  typeof tc.args?.command === 'string' ? tc.args.command : '';
                const exitMatch = tc.result?.match(/exit (\d+)/);
                const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
                const failed = exitCode !== null && exitCode !== 0;
                const rawResult = tc.result || '';
                const analysisIdx = rawResult.indexOf('[失败分析]');
                const hasAnalysis = analysisIdx >= 0;
                const resultText =
                  (hasAnalysis ? rawResult.slice(0, analysisIdx) : rawResult).length > 300
                    ? `${(hasAnalysis ? rawResult.slice(0, analysisIdx) : rawResult).slice(0, 300)}…`
                    : hasAnalysis ? rawResult.slice(0, analysisIdx) : rawResult;
                const analysisText = hasAnalysis
                  ? rawResult.slice(analysisIdx + '[失败分析]'.length).trim()
                  : '';
                return (
                  <View key={idx} style={styles.toolCallItem}>
                    <View style={styles.toolCallHeader}>
                      <AppIcon name={toolIcon(tc.name)} size={11} color={colors.primary} />
                      <Text style={styles.toolCallName}>{tc.name}</Text>
                      {exitCode !== null && (
                        <Text
                          style={[
                            styles.toolCallExit,
                            failed && styles.toolCallExitError,
                          ]}
                        >
                          {failed ? `exit ${exitCode}` : 'ok'}
                        </Text>
                      )}
                    </View>
                    {command ? (
                      <Text style={styles.toolCallCommand} numberOfLines={2}>
                        $ {command}
                      </Text>
                    ) : tc.args && Object.keys(tc.args).length > 0 ? (
                      <Text style={styles.toolCallArgs} numberOfLines={2}>
                        {JSON.stringify(tc.args).slice(0, 100)}
                      </Text>
                    ) : null}
                    {resultText ? (
                      <Text
                        style={[
                          styles.toolCallResult,
                          failed && styles.toolCallResultError,
                        ]}
                        numberOfLines={4}
                      >
                        {resultText}
                      </Text>
                    ) : null}
                    {hasAnalysis && (
                      <View style={styles.failCard}>
                        <View style={styles.failCardHeader}>
                          <FontAwesome6 name="wand-magic-sparkles" size={10} color={colors.warning} />
                          <Text style={styles.failCardTitle}>失败智能分析</Text>
                        </View>
                        <Text style={styles.failCardBody}>{analysisText}</Text>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </Pressable>
      </Animated.View>
    );
  }, [openMessageMenu, styles, messageEntry]);

  const modelLabel = currentModel.startsWith('deepseek-')
    ? currentModel.slice('deepseek-'.length)
    : currentModel.length > 8
      ? `${currentModel.slice(0, 8)}…`
      : currentModel;

  const currentProjectName = currentProjectId
    ? projectOptions.find((p) => p.id === currentProjectId)?.name
    : null;

  const bottomOffset = keyboardShown
    ? (Platform.OS === 'ios' ? keyboardHeight : 0)
    : insets.bottom;

  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle={isDark ? 'light' : 'dark'} safeAreaEdges={['top', 'left', 'right']} scrollable={false}>
      <View style={styles.container}>
        <View style={styles.panes}>
        <View style={[styles.leftPane, isSideBySide && styles.leftPaneWide]}>
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
            {deviceReady !== null && (
              <View style={[styles.deviceBadge, deviceReady && styles.deviceBadgeOn]}>
                <FontAwesome6 name="hand-pointer" size={10} color={deviceReady ? colors.primary : colors.textMuted} />
                <Text style={[styles.deviceBadgeText, deviceReady && styles.deviceBadgeTextOn]}>
                  {deviceReady ? '设备控制' : '未开启'}
                </Text>
              </View>
            )}
            {balance !== null && (
              <View style={styles.balanceBadge}>
                <FontAwesome6 name="coins" size={10} color={colors.primary} />
                <Text style={styles.balanceText}>${balance.toFixed(2)}</Text>
              </View>
            )}
            <Pressable style={styles.headerAction} onPress={() => setTaskPanelVisible(!taskPanelVisible)}>
              <PanelToggleIcon
                open={taskPanelVisible}
                sideBySide={isSideBySide}
                color={taskPanelVisible ? colors.primary : colors.textSecondary}
              />
            </Pressable>
          </View>
        </View>

        {/* Project bar */}
        <Pressable style={styles.projectBar} onPress={openProjectPicker}>
          <FontAwesome6
            name="folder-open"
            size={12}
            color={currentProjectId ? colors.primary : colors.warning}
          />
          <Text style={styles.projectBarText} numberOfLines={1}>
            {currentProjectId
              ? currentProjectName || '项目已绑定'
              : '未绑定项目 — 点击选择，Agent 才能执行命令/工具'}
          </Text>
          <FontAwesome6 name="chevron-down" size={10} color={colors.textMuted} />
        </Pressable>

        {/* Agent 类型选择器（独立上下文/角色） */}
        <View style={styles.agentSelector}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.agentSelectorContent}
          >
            {AGENT_OPTIONS.map((opt) => {
              const active = agentType === opt.key;
              return (
                <Pressable
                  key={opt.key}
                  style={[styles.agentChip, active && styles.agentChipActive]}
                  onPress={() => switchAgent(opt.key)}
                >
                  <FontAwesome6 name={opt.icon} size={11} color={active ? '#FFFFFF' : colors.textSecondary} />
                  <Text style={[styles.agentChipText, active && styles.agentChipTextActive]}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {/* 精简任务卡片 */}
        {currentTask && (
          <Animated.View {...cardEntry}>
            <PressableScale style={styles.taskCard} onPress={() => setTaskPanelVisible(true)}>
              <View style={styles.taskCardHeader}>
                <AppIcon name="list-checks" size={12} color={colors.primary} />
                <Text style={styles.taskCardName} numberOfLines={1}>{currentTask.name}</Text>
                <Text style={[styles.taskCardStatus, currentTask.status === 'running' && styles.taskCardStatusRunning]}>
                  {currentTask.status === 'running' ? '执行中' : currentTask.status === 'done' ? '已完成' : currentTask.status === 'cancelled' ? '已取消' : '出错'}
                </Text>
              </View>
              <AnimatedProgressBar
                progress={
                  currentTask.steps.length > 0
                    ? currentTask.steps.filter((st) => st.status === 'done' || st.status === 'error').length / currentTask.steps.length
                    : currentTask.status === 'running' ? 0.08 : 1
                }
                color={colors.primary}
                trackColor={colors.bgInput}
                height={4}
              />
              <Text style={styles.taskCardHint}>点击查看任务详情</Text>
            </PressableScale>
          </Animated.View>
        )}

        {/* Messages */}
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={(item) => item.id}
          style={styles.messageList}
          contentContainerStyle={[
            styles.messageContentArea,
            { paddingBottom: inputAreaHeight + bottomOffset + spacing.md },
          ]}
          onContentSizeChange={() => {
            flatListRef.current?.scrollToEnd({ animated: true });
          }}
          ListEmptyComponent={
            initialLoading ? (
              <View style={styles.skeletonWrap}>
                <Skeleton width="85%" height={52} colors={colors} />
                <Skeleton width="70%" height={52} colors={colors} />
                <Skeleton width="90%" height={52} colors={colors} />
              </View>
            ) : (
              <View style={styles.emptyState}>
                <View style={styles.emptyLogo}>
                  <AppIcon name="bolt" size={28} color={colors.primary} />
                </View>
                <Text style={styles.emptyTitle}>SYNAPS AGENT</Text>
                <Text style={styles.emptyDesc}>
                  开始你的第一次对话{''}
                  {'\n'}告诉我你想开发或修复什么
                </Text>
              </View>
            )
          }
          ListFooterComponent={
            isStreaming ? (
              streamingContent ? (
                <View style={[styles.messageRow, styles.messageRowAssistant]}>
                  <View style={[styles.avatarCircle, styles.avatarBot]}>
                    <AppIcon name="bot" size={14} color={colors.primary} />
                  </View>
                  <View style={[styles.messageBubble, styles.assistantBubble]}>
                    <Text style={styles.messageContent}>{streamingContent}</Text>
                    {currentToolCalls.length > 0 && (
                      <View style={styles.toolCallsContainer}>
                        {currentToolCalls.map((tc, idx) => {
                          const command =
                            typeof tc.args?.command === 'string' ? tc.args.command : '';
                          return (
                            <View key={idx} style={styles.toolCallBadge}>
                              <ToolSpinner size={12} color={colors.primary} />
                              <Text style={styles.toolCallText} numberOfLines={1}>
                                {tc.name}
                                {command ? `: ${command}` : ''}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    )}
                  </View>
                </View>
              ) : (
                <View style={[styles.messageRow, styles.messageRowAssistant]}>
                  <View style={[styles.avatarCircle, styles.avatarBot]}>
                    <AppIcon name="bot" size={14} color={colors.primary} />
                  </View>
                  <View style={[styles.messageBubble, styles.assistantBubble, styles.thinkingBubble]}>
                    <ThinkingDots color={colors.primary} size={6} />
                    <Text style={styles.thinkingText}>Agent 思考中...</Text>
                  </View>
                </View>
              )
            ) : null
          }
        />

        {/* Input */}
        <View
          style={[styles.inputContainer, { bottom: bottomOffset }]}
          onLayout={(e) => setInputAreaHeight(e.nativeEvent.layout.height)}
        >
          {replyingTo && (
            <View style={styles.replyBar}>
              <View style={styles.replyBarLine} />
              <View style={styles.replyBarContent}>
                <Text style={styles.replyBarLabel}>
                  {replyingTo.role === 'user' ? 'YOU' : 'SYNAPS'}
                </Text>
                <Text style={styles.replyBarText} numberOfLines={1}>
                  {replyingTo.content}
                </Text>
              </View>
              <Pressable
                style={styles.replyBarClose}
                onPress={() => setReplyingTo(null)}
                hitSlop={8}
              >
                <FontAwesome6 name="xmark" size={12} color={colors.textSecondary} />
              </Pressable>
            </View>
          )}
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
              style={styles.modelButton}
              onPress={switchModel}
              disabled={isStreaming || isRecording}
            >
              <FontAwesome6 name="microchip" size={11} color={colors.textSecondary} />
              <Text style={styles.modelButtonText} numberOfLines={1}>
                {modelLabel}
              </Text>
            </Pressable>
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

        </View>

        {/* 右栏（横屏/平板并排显示） */}
        {isSideBySide && (
          <View style={styles.rightPane}>
            <TaskPanel
              task={currentTask}
              colors={colors}
              isDark={isDark}
              onCancel={cancelTask}
              onRerun={rerunTask}
              onRollback={rollbackTask}
            />
          </View>
        )}
        </View>

        {/* 任务面板抽屉（竖屏） */}
        {!isSideBySide && (
          <Modal visible={taskPanelVisible} transparent animationType="slide" onRequestClose={() => setTaskPanelVisible(false)}>
            <View style={styles.drawerContainer}>
              <Pressable style={styles.drawerBackdrop} onPress={() => setTaskPanelVisible(false)} />
              <View style={styles.drawerPanel}>
                <View style={styles.drawerHandle} />
                <TaskPanel
                  task={currentTask}
                  colors={colors}
                  isDark={isDark}
                  onCancel={cancelTask}
                  onRerun={rerunTask}
                  onRollback={rollbackTask}
                />
              </View>
            </View>
          </Modal>
        )}

        {/* Message action menu */}
        <Modal
          visible={!!menuMessage}
          transparent
          animationType="fade"
          onRequestClose={closeMessageMenu}
        >
          <Pressable style={styles.modalOverlay} onPress={closeMessageMenu}>
            <Pressable
              style={[styles.modalContainer, { paddingBottom: spacing.xl + insets.bottom }]}
              onPress={() => {}}
            >
              <Text style={styles.modalTitle}>Message actions</Text>
              <Pressable
                style={styles.modalItem}
                onPress={() => menuMessage && copyMessage(menuMessage)}
              >
                <FontAwesome6 name="copy" size={14} color={colors.primary} />
                <Text style={styles.modalItemText}>复制</Text>
              </Pressable>
              <Pressable
                style={styles.modalItem}
                onPress={() => menuMessage && quoteMessage(menuMessage)}
              >
                <FontAwesome6 name="quote-left" size={14} color={colors.primary} />
                <Text style={styles.modalItemText}>引用回复</Text>
              </Pressable>
              <Pressable
                style={styles.modalItem}
                onPress={() => menuMessage && shareMessage(menuMessage)}
              >
                <FontAwesome6 name="share-nodes" size={14} color={colors.primary} />
                <Text style={styles.modalItemText}>分享</Text>
              </Pressable>
              <Pressable style={[styles.modalItem, styles.modalItemCancel]} onPress={closeMessageMenu}>
                <Text style={styles.modalItemCancelText}>取消</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        {/* Project picker */}
        <Modal
          visible={projectPickerVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setProjectPickerVisible(false)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setProjectPickerVisible(false)}>
            <Pressable
              style={[styles.modalContainer, { paddingBottom: spacing.xl + insets.bottom }]}
              onPress={() => {}}
            >
              <Text style={styles.modalTitle}>选择项目</Text>
              {projectOptions.length === 0 && (
                <Text style={styles.modalEmpty}>暂无项目，请先到「项目」模块创建</Text>
              )}
              {projectOptions.map((project) => (
                <Pressable
                  key={project.id}
                  style={styles.projectOption}
                  onPress={() => selectProject(project)}
                >
                  <FontAwesome6 name="folder" size={13} color={colors.primary} />
                  <View style={styles.projectOptionInfo}>
                    <Text style={styles.projectOptionName} numberOfLines={1}>
                      {project.name}
                    </Text>
                    <Text style={styles.projectOptionPath} numberOfLines={1}>
                      {project.path}
                    </Text>
                  </View>
                  {project.id === currentProjectId && (
                    <FontAwesome6 name="check" size={12} color={colors.success} />
                  )}
                </Pressable>
              ))}
              <Pressable
                style={[styles.modalItem, styles.modalItemCancel]}
                onPress={() => setProjectPickerVisible(false)}
              >
                <Text style={styles.modalItemCancelText}>取消</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        {/* Permission request */}
        <Modal
          visible={!!permissionRequest}
          transparent
          animationType="fade"
          onRequestClose={() => respondPermission(false)}
        >
          <View style={styles.permissionOverlay}>
            <View style={styles.permissionCard}>
              <View style={styles.permissionHeader}>
                <FontAwesome6
                  name={
                    permissionRequest?.level === 'high'
                      ? 'triangle-exclamation'
                      : 'shield-halved'
                  }
                  size={16}
                  color={
                    permissionRequest?.level === 'high'
                      ? colors.warning
                      : colors.primary
                  }
                />
                <Text style={styles.permissionTitle}>
                  {permissionRequest?.level === 'high'
                    ? '高风险操作确认'
                    : '操作确认'}
                </Text>
              </View>
              {permissionRequest?.args.command ? (
                <Text style={styles.permissionCommand}>
                  $ {permissionRequest.args.command}
                </Text>
              ) : permissionRequest?.args.path ? (
                <Text style={styles.permissionCommand}>
                  {permissionRequest.args.path}
                </Text>
              ) : permissionRequest?.args.query ? (
                <Text style={styles.permissionCommand}>
                  {permissionRequest.args.query}
                </Text>
              ) : permissionRequest?.args.repo ? (
                <Text style={styles.permissionCommand}>
                  repo: {permissionRequest.args.repo}
                </Text>
              ) : permissionRequest?.args.url ? (
                <Text style={styles.permissionCommand}>
                  {permissionRequest.args.url}
                </Text>
              ) : permissionRequest?.args.server && permissionRequest?.args.method ? (
                <Text style={styles.permissionCommand}>
                  {permissionRequest.args.server}.{permissionRequest.args.method}
                </Text>
              ) : permissionRequest?.args.server ? (
                <Text style={styles.permissionCommand}>
                  server: {permissionRequest.args.server}
                </Text>
              ) : permissionRequest?.args.message ? (
                <Text style={styles.permissionCommand}>
                  {permissionRequest.args.message}
                </Text>
              ) : null}
              <Text style={styles.permissionImpact}>
                {permissionRequest?.impact}
              </Text>
              <View style={styles.permissionActions}>
                <Pressable
                  style={[styles.permissionBtn, styles.permissionBtnDeny]}
                  onPress={() => respondPermission(false)}
                >
                  <Text style={styles.permissionBtnDenyText}>拒绝</Text>
                </Pressable>
                <Pressable
                  style={[styles.permissionBtn, styles.permissionBtnAllow]}
                  onPress={() => respondPermission(true)}
                >
                  <Text style={styles.permissionBtnAllowText}>允许</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </Screen>
  );
}

const createStyles = (colors: ThemeColors, isDark: boolean) => StyleSheet.create({
  panes: {
    flex: 1,
    flexDirection: 'row',
  },
  leftPane: {
    flex: 1,
  },
  leftPaneWide: {
    width: '60%',
    maxWidth: 720,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  rightPane: {
    width: '40%',
    minWidth: 300,
    backgroundColor: colors.bgRoot,
  },
  drawerContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  drawerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  drawerPanel: {
    width: '82%',
    maxWidth: 460,
    backgroundColor: colors.bgRoot,
    borderTopLeftRadius: radius.lg,
    borderBottomLeftRadius: radius.lg,
    overflow: 'hidden',
  },
  drawerHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
  },
  agentSelector: {
    flexGrow: 0,
    marginTop: spacing.sm,
    overflow: 'hidden',
  },
  agentSelectorContent: {
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  agentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  agentChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  agentChipText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  agentChipTextActive: {
    color: '#FFFFFF',
  },
  taskCard: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.sm,
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    gap: 6,
  },
  taskCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  taskCardName: {
    flex: 1,
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  taskCardStatus: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textMuted,
  },
  taskCardStatusRunning: {
    color: '#F59E0B',
  },
  taskCardTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.bgInput,
    overflow: 'hidden',
  },
  taskCardFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  taskCardHint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
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
  deviceBadge: {
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
  deviceBadgeOn: {
    backgroundColor: colors.primaryGlow,
    borderColor: colors.primaryBorder,
  },
  deviceBadgeText: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    fontWeight: '600',
  },
  deviceBadgeTextOn: {
    color: colors.primary,
  },
  headerAction: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: 'rgba(85,85,85,0.06)',
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    borderRadius: radius.md,
  },
  projectBarText: {
    flex: 1,
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  messageList: {
    flex: 1,
  },
  messageContentArea: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  messageRowInner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    flexShrink: 1,
    maxWidth: '100%',
  },
  messageRowUser: {
    justifyContent: 'flex-end',
  },
  messageRowAssistant: {
    justifyContent: 'flex-start',
  },
  avatarCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarUser: {
    backgroundColor: colors.primaryDark,
  },
  avatarBot: {
    backgroundColor: colors.primaryGlow,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  messageBubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  userBubble: {
    backgroundColor: colors.primaryDark,
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  thinkingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minWidth: 120,
  },
  thinkingText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
  },
  messageContent: {
    fontSize: fontSize.md,
    color: colors.textPrimary,
    lineHeight: 22,
  },
  messageContentUser: {
    color: '#FFFFFF',
  },
  replyPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
  },
  replyPreviewLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.primary,
    letterSpacing: 1,
  },
  replyPreviewLabelUser: {
    color: '#FFFFFF',
  },
  replyPreviewText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: 2,
  },
  replyPreviewTextUser: {
    color: 'rgba(255,255,255,0.85)',
  },
  replyPreviewUser: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderLeftColor: 'rgba(255,255,255,0.6)',
  },
  toolCallsContainer: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: 'rgba(85,85,85,0.1)',
    gap: spacing.sm,
  },
  toolCallsLabel: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  toolCallItem: {
    backgroundColor: 'rgba(85,85,85,0.05)',
    borderRadius: radius.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(85,85,85,0.15)',
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
  toolCallExit: {
    fontSize: fontSize.xs,
    color: colors.success,
    fontWeight: '700',
  },
  toolCallExitError: {
    color: colors.error,
  },
  toolCallArgs: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  toolCallCommand: {
    fontSize: 10,
    color: colors.textSecondary,
    marginTop: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  toolCallResult: {
    fontSize: 10,
    color: colors.textSecondary,
    marginTop: 6,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  failCard: {
    marginTop: spacing.xs,
    backgroundColor: isDark ? 'rgba(251,191,36,0.10)' : 'rgba(217,119,6,0.08)',
    borderWidth: 1,
    borderColor: isDark ? 'rgba(251,191,36,0.25)' : 'rgba(217,119,6,0.25)',
    borderRadius: radius.sm,
    padding: spacing.sm,
    gap: 4,
  },
  failCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  failCardTitle: {
    fontSize: fontSize.xs,
    color: colors.warning,
    fontWeight: '700',
  },
  failCardBody: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    lineHeight: 17,
  },
  toolCallResultError: {
    color: '#fca5a5',
  },
  toolCallBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    backgroundColor: 'rgba(85,85,85,0.1)',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(85,85,85,0.2)',
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
  skeletonWrap: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
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
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgRoot,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(85,85,85,0.08)',
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  replyBarLine: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  replyBarContent: {
    flex: 1,
  },
  replyBarLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.primary,
    letterSpacing: 1,
  },
  replyBarText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: 2,
  },
  replyBarClose: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
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
  modelButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: spacing.sm,
    marginBottom: 4,
    marginLeft: spacing.sm,
    maxWidth: 110,
  },
  modelButtonText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '600',
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
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.xs,
  },
  modalTitle: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  modalEmpty: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  modalItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  modalItemText: {
    fontSize: fontSize.md,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  modalItemCancel: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginTop: spacing.sm,
    justifyContent: 'center',
  },
  modalItemCancelText: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  projectOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  projectOptionInfo: {
    flex: 1,
  },
  projectOptionName: {
    fontSize: fontSize.md,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  projectOptionPath: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: 2,
  },

  permissionOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
  },
  permissionCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
  },
  permissionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  permissionTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  permissionCommand: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  permissionImpact: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 18,
    marginBottom: spacing.lg,
  },
  permissionActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  permissionBtn: {
    flex: 1,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  permissionBtnDeny: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: colors.border,
  },
  permissionBtnDenyText: {
    color: colors.textSecondary,
    fontWeight: '600',
  },
  permissionBtnAllow: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  permissionBtnAllowText: {
    color: '#0A0A0F',
    fontWeight: '700',
  },
});
