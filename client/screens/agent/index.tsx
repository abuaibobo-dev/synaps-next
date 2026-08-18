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
  Linking,
  Modal,
  Share,
  Image,
  Vibration,
  BackHandler,
  useWindowDimensions,
  KeyboardAvoidingView,
  AppState,
  TouchableWithoutFeedback,
  AppStateStatus,
} from 'react-native';
import EventSource from 'react-native-sse';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import { Audio } from 'expo-av';
import * as Speech from 'expo-speech';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  withRepeat,
  withSequence,
  cancelAnimation,
  Easing,
  ReduceMotion,
} from 'react-native-reanimated';
import { AppIcon, toolIcon } from '@/components/AppIcon';
import DiagramView from '@/components/DiagramView';
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

const MODEL_OPTIONS = ['deepseek-v4-flash', 'deepseek-reasoner'];

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  replyingTo?: { content: string; role: string };
  status?: 'pending' | 'sending' | 'sent' | 'error' | 'cancelled';
  attachments?: Array<{ name: string; path?: string; uri?: string; type: 'image' | 'file' }>;
}

interface PendingAttachment {
  id: string;
  name: string;
  uri: string;
  type: 'image' | 'file';
  mimeType?: string;
  size?: number;
}

interface QueueItem {
  id: string;
  userMsgId: string;
  prompt: string;
  replyingTo?: { content: string; role: string };
  attachments?: Message['attachments'];
  isPriority: boolean;
  createdAt: number;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) {
    const days = Math.floor(diff / 86_400_000);
    return days === 1 ? '昨天' : `${days} 天前`;
  }
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


const TEMPLATES: Array<{ label: string; prompt: string }> = [
  { label: '检查代码并修复', prompt: '请检查当前项目的代码质量，运行 lint 和类型检查，发现问题后直接修复。' },
  { label: '构建 APK', prompt: '请为当前项目构建 APK：打 tag、触发 GitHub Actions 构建并等待完成，完成后告诉我下载链接。' },
  { label: '看看项目', prompt: '请查看当前项目的整体结构和最近改动，给我一个简洁的项目概览。' },
];

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

/* ==================== AI-Native UI：富内容渲染 ==================== */

interface ContentBlock {
  type: 'text' | 'code' | 'insight' | 'diagram';
  text: string;
  lang?: string;
  icon?: string;
  title?: string;
}

/** 结构化洞察卡片（Agent 思考/计划/反思等），按图标识别，灰白中性风格 */
const INSIGHT_PATTERNS: Array<{ icon: string; title: string; match: RegExp }> = [
  { icon: 'brain', title: '思考过程', match: /^\u{1F9E0}/u },
  { icon: 'circle-question', title: '执行前判断', match: /^\u{1F914}/u },
  { icon: 'eye', title: '多视角分析', match: /^\u{1F441}/u },
  { icon: 'list-check', title: '执行计划', match: /^\u{1F4CB}/u },
  { icon: 'chart-simple', title: '进度报告', match: /^\u{1F4CA}/u },
  { icon: 'rotate', title: '反思', match: /^\u{1F504}/u },
  { icon: 'lightbulb', title: '经验关联', match: /^\u{1F4A1}/u },
  { icon: 'triangle-exclamation', title: '风险提示', match: /^\u{26A0}/u },
  { icon: 'thumbtack', title: '综合判断', match: /^\u{1F4CC}/u },
  { icon: 'note-sticky', title: '记录', match: /^\u{1F4DD}/u },
  { icon: 'book', title: '引用记忆', match: /^\u{1F4D6}/u },
];

function splitInsightText(text: string): ContentBlock[] {
  const lines = text.split('\n');
  const out: ContentBlock[] = [];
  let buf: string[] = [];
  let current: { icon: string; title: string } | null = null;
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) {
      out.push(
        current
          ? { type: 'insight', text: body, icon: current.icon, title: current.title }
          : { type: 'text', text: body }
      );
    }
    buf = [];
    current = null;
  };
  for (const line of lines) {
    const hit = INSIGHT_PATTERNS.find((p) => p.match.test(line));
    if (hit) {
      flush();
      current = { icon: hit.icon, title: hit.title };
      const rest = line.replace(hit.match, '').replace(/^[：:\s]+/, '').trim();
      if (rest) buf.push(rest);
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** 将消息内容拆分为 图表 / 代码块 / 洞察卡片 / 纯文本 四种渲染单元 */
const DIAGRAM_MARKER = '__SYNAPS_DIAGRAM__';

/** 流式阶段隐藏原始图表标记，避免把 SVG 源码当文本显示 */
export function stripDiagramMarkup(text: string): string {
  if (!text.includes(DIAGRAM_MARKER)) return text;
  return text.replace(/__SYNAPS_DIAGRAM__\s*<svg[\s\S]*?<\/svg>/g, '[图表生成中…]');
}

function parseContentBlocks(content: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const markerIdx = content.indexOf(DIAGRAM_MARKER);
  if (markerIdx > -1) {
    if (markerIdx > 0) blocks.push(...parseContentBlocks(content.slice(0, markerIdx)));
    const svgStart = content.indexOf('<svg', markerIdx);
    const svgEnd = svgStart > -1 ? content.indexOf('</svg>', svgStart) : -1;
    if (svgStart > -1 && svgEnd > -1) {
      blocks.push({ type: 'diagram', text: content.slice(svgStart, svgEnd + '</svg>'.length) });
      const tail = content.slice(svgEnd + '</svg>'.length);
      if (tail.trim()) blocks.push(...parseContentBlocks(tail));
    } else {
      const tail = content.slice(markerIdx + DIAGRAM_MARKER.length);
      if (tail.trim()) blocks.push(...parseContentBlocks(tail));
    }
    return blocks;
  }
  const fenceRe = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(content)) !== null) {
    if (m.index > last) blocks.push(...splitInsightText(content.slice(last, m.index)));
    blocks.push({ type: 'code', lang: m[1] || 'code', text: m[2].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < content.length) blocks.push(...splitInsightText(content.slice(last)));
  if (blocks.length === 0) blocks.push({ type: 'text', text: content });
  return blocks;
}

/** 代码块卡片：语言徽标 + 复制按钮 + 等宽字体横向滚动 */
function CodeCard({
  lang,
  text,
  colors,
  styles,
}: {
  lang: string;
  text: string;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
}) {
  const copyCode = useCallback(async () => {
    await Clipboard.setStringAsync(text);
    Toast.show({ type: 'success', text1: '代码已复制' });
  }, [text]);
  return (
    <View style={styles.codeCard}>
      <View style={styles.codeCardHeader}>
        <Text style={styles.codeCardLang}>{lang}</Text>
        <Pressable onPress={copyCode} hitSlop={6}>
          <Text style={styles.codeCardCopy}>复制</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.codeCardBody} selectable>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

/** 洞察卡片：图标 + 标题 + 正文 */
function InsightCard({
  icon,
  title,
  text,
  colors,
  styles,
}: {
  icon: string;
  title: string;
  text: string;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.insightCard}>
      <View style={styles.insightCardHeader}>
        <FontAwesome6 name={icon as any} size={11} color={colors.textSecondary} />
        <Text style={styles.insightCardTitle}>{title}</Text>
      </View>
      <Text style={styles.insightCardBody} selectable>
        {text}
      </Text>
    </View>
  );
}

/** 消息正文富渲染：代码块/洞察卡片/纯文本 */
function RichContent({
  content,
  isUser,
  colors,
  styles,
}: {
  content: string;
  isUser: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
}) {
  const blocks = useMemo(() => parseContentBlocks(content), [content]);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'diagram') {
          return <DiagramView key={i} svg={b.text} colors={colors} />;
        }
        if (b.type === 'code') {
          return <CodeCard key={i} lang={b.lang || 'code'} text={b.text} colors={colors} styles={styles} />;
        }
        if (b.type === 'insight') {
          return <InsightCard key={i} icon={b.icon || 'note-sticky'} title={b.title || '记录'} text={b.text} colors={colors} styles={styles} />;
        }
        return (
          <Text key={i} style={[styles.messageContent, isUser && styles.messageContentUser]}>
            {b.text}
          </Text>
        );
      })}
    </>
  );
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
  const [displayedText, setDisplayedText] = useState('');
  const typewriterRef = useRef('');
  const [thinking, setThinking] = useState('');
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [currentToolCalls, setCurrentToolCalls] = useState<ToolCall[]>([]);
  const [runningTool, setRunningTool] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueMenu, setQueueMenu] = useState<QueueItem | null>(null);
  const [queueManagerVisible, setQueueManagerVisible] = useState(false);
  const [networkError, setNetworkError] = useState(false);
  const [currentModel, setCurrentModel] = useState(MODEL_OPTIONS[0]);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [menuMessage, setMenuMessage] = useState<Message | null>(null);
  const [attachMenuVisible, setAttachMenuVisible] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);

  // 加载草稿
  useEffect(() => {
    const loadDraft = async () => {
      try {
        const draft = await AsyncStorage.getItem(`chat_draft_${currentProjectId || 'default'}`);
        if (draft) setInputText(draft);
      } catch {
        // Ignore
      }
    };
    loadDraft();
  }, [currentProjectId]);

  // 保存草稿
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        if (inputText.trim()) {
          await AsyncStorage.setItem(`chat_draft_${currentProjectId || 'default'}`, inputText);
        } else {
          await AsyncStorage.removeItem(`chat_draft_${currentProjectId || 'default'}`);
        }
      } catch {
        // Ignore
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [inputText, currentProjectId]);

  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [projectPickerVisible, setProjectPickerVisible] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [trustProjectChecked, setTrustProjectChecked] = useState(false);
  const [executorLabel, setExecutorLabel] = useState<string | null>(null);
  const [deviceReady, setDeviceReady] = useState<boolean | null>(null);
  const [currentTask, setCurrentTask] = useState<TaskRecord | null>(null);
  const [taskPanelVisible, setTaskPanelVisible] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);

  // 搜索过滤后的消息列表
  const filteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter((m) => m.content.toLowerCase().includes(q));
  }, [messages, searchQuery]);
  const [agentType, setAgentType] = useState<AgentOptionKey>('scheduler');
  const [agentInstanceIds, setAgentInstanceIds] = useState<Record<string, string>>({});
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);

  // 带指数退避重试的 fetch 包装器
  const fetchWithRetry = useCallback(async (url: string, options: RequestInit = {}, retries = 2) => {
    let lastError: Error | null = null;
    for (let i = 0; i <= retries; i++) {
      try {
        const response = await fetch(url, options);
        if (!response.ok && response.status >= 500) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < retries) {
          const delay = Math.min(1000 * Math.pow(2, i), 10000); // 1s, 2s, 4s, max 10s
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }, []);

  // 后台任务持久化：App 切到后台时保存状态
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      setAppState(nextAppState);
      if (nextAppState === 'background' && isStreamingRef.current) {
        // 后台继续运行，不中断任务
        console.log('[Synaps] App entering background, task continues...');
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, []);
  const requestIdRef = useRef<string>('');
  const currentUserMsgIdRef = useRef<string>('');
  const queueRef = useRef<QueueItem[]>([]);
  const isStreamingRef = useRef(false);
  const cursorShared = useSharedValue(1);
  const cursorStyle = useAnimatedStyle(() => ({ opacity: cursorShared.value }));
  const thinkingPulse = useSharedValue(1);
  const thinkingPulseStyle = useAnimatedStyle(() => ({ opacity: thinkingPulse.value }));
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isSideBySide = windowWidth >= 600 && windowWidth > windowHeight * 0.8;
  const insets = useSafeAreaInsets();
  const [keyboardShown, setKeyboardShown] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const esRef = useRef<EventSource | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const autoSpeakRef = useRef(false);
  const speakMessageRef = useRef<((text: string) => void) | null>(null);

  // 网络健康探测（余额展示已移至设置页）
  const fetchBalance = async () => {
    try {
      await fetchWithRetry(`${API_BASE}/api/v1/balance`);
      setNetworkError(false);
    } catch {
      setNetworkError(true);
    }
  };

  const fetchProjectOptions = useCallback(async () => {
    try {
      const response = await fetchWithRetry(`${API_BASE}/api/v1/projects`);
      const data = await response.json();
      setProjectOptions(data.projects || []);
    } catch {
      // Keep existing list
    }
  }, [fetchWithRetry]);

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
        if (data && typeof data.ai_api_key === 'string') {
          setHasApiKey(data.ai_api_key.trim().length > 0);
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
      if (!response.ok) return {};
      const data = await response.json();
      const map: Record<string, string> = {};
      for (const a of data.agents || []) {
        if (a && typeof a.type === 'string' && typeof a.id === 'string') map[a.type] = a.id;
      }
      setAgentInstanceIds(map);
      return map;
    } catch {
      // 忽略：后端未就绪时静默重试
      return {};
    }
  }, []);

  const loadAgentHistory = useCallback(async (type: string, instanceId?: string, projectId?: string | null) => {
    if (instanceId) {
      try {
        const response = await fetch(`${API_BASE}/api/v1/chat/agent-history?agentInstanceId=${encodeURIComponent(instanceId)}`);
        if (response.ok) {
          const data = await response.json();
          const msgs: Message[] = (data.messages || []).map(
            (m: { id: string; role: string; content: string; created_at: string }) => ({
              id: m.id || `${m.created_at}-${m.role}`,
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
              timestamp: new Date(m.created_at + 'Z').getTime(),
            })
          );
          if (msgs.length > 0) {
            setMessages(msgs);
            return;
          }
        }
      } catch {
        // 实例历史不可用时回退到会话历史
      }
    }
    // 兜底：加载会话历史（chat_messages），确保历史对话可见
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
      // 忽略
    }
  }, []);

  // 后端健康自检：未启动时显示横幅并自动重试
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`${API_BASE}/api/v1/health`, { signal: ctrl.signal });
        clearTimeout(t);
        if (cancelled) return;
        setBackendOnline(res.ok);
      } catch {
        clearTimeout(t);
        if (cancelled) return;
        setBackendOnline(false);
      }
    };
    check();
    const timer = setInterval(check, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    (async () => {
      const map = await loadAgents(currentProjectId);
      await loadAgentHistory(agentType, map[agentType], currentProjectId);
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
    loadAgentHistory(type, agentInstanceIds[type], currentProjectId);
  }, [agentInstanceIds, loadAgentHistory, currentProjectId]);

  // Track keyboard visibility so the input area can extend to the bottom edge
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(showEvent, () => {
      setKeyboardShown(true);
    });
    const s2 = Keyboard.addListener(hideEvent, () => {
      setKeyboardShown(false);
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
      if (requestIdRef.current) {
        try {
          fetch(`${API_BASE}/api/v1/chat/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: requestIdRef.current }),
          }).catch(() => {});
        } catch {}
      }
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

  const runQueueItemRef = useRef<(item: QueueItem) => void>(() => {});

  // 从队列取下一个任务（插队消息在队首，优先处理）
  const dequeueNext = useCallback(() => {
    if (isStreamingRef.current) return;
    if (queueRef.current.length === 0) return;
    const [next, ...rest] = queueRef.current;
    queueRef.current = rest;
    setQueue(queueRef.current);
    runQueueItemRef.current(next);
  }, []);

  const runQueueItem = useCallback((item: QueueItem) => {
    if (!item || isStreamingRef.current) return;
    isStreamingRef.current = true;
    currentUserMsgIdRef.current = item.userMsgId;

    const requestId = `task-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    requestIdRef.current = requestId;

    // 创建任务记录
    const task: TaskRecord = {
      id: requestId,
      name: item.prompt.replace(/\n/g, ' ').slice(0, 60),
      prompt: item.prompt,
      startedAt: Date.now(),
      status: 'running',
      steps: [],
      tools: [],
      files: [],
    };
    setCurrentTask(task);

    // 该消息进入发送中状态
    setMessages((prev) =>
      prev.map((m) => (m.id === item.userMsgId ? { ...m, status: 'sending' } : m))
    );

    // Build conversation history for the API（排队中的消息不参与历史，当前消息由 prompt 追加）
    const conversationHistory = [
      { role: 'system' as const, content: 'You are Synaps, an AI software development agent running on a mobile phone. You help users develop, debug, build and release software through natural language. Be concise, technical, and action-oriented. When the user describes a task, break it down into steps and execute them. Respond in the same language the user uses.' },
      ...messages
        .filter((m) => m.id !== item.userMsgId && m.status !== 'pending')
        .map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: item.prompt },
    ];

    setIsStreaming(true);
    setStreamingContent('');
    setDisplayedText('');
    typewriterRef.current = '';
    setThinking('');
    setCurrentToolCalls([]);
    setExecutorLabel(null);

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

    // 收尾守卫：确保用户消息状态只被结算一次（[DONE] / 看门狗 / 连接断开 三选一）
    let settled = false;
    const settleUser = (status: Message['status']) => {
      if (settled) return;
      settled = true;
      setMessages((prev) =>
        prev.map((m) => (m.id === item.userMsgId ? { ...m, status } : m))
      );
    };

    // 看门狗：长时间无数据（工具执行卡住/网络静默）时自动结束，避免无限等待
    let lastEventAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastEventAt > 120_000) {
        clearInterval(watchdog);
        clearInterval(typeTimer);
        setDisplayedText(typewriterRef.current);
        try {
          fetch(`${API_BASE}/api/v1/chat/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId }),
          }).catch(() => {});
        } catch {}
        if (esRef.current === es) es.close();
        const timeoutMsg: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content:
            (accumulated ? accumulated + '\n\n' : '') +
            '[响应超时] 后端长时间无响应（可能后端服务未运行或工具执行卡住）。请检查：1) 通知栏是否显示「本地后端服务运行中」；2) 是否已绑定项目；3) 稍后重试。',
          timestamp: Date.now(),
          status: 'error',
        };
        setMessages((prev) => [...prev, timeoutMsg]);
        patchTask((t) => ({ ...t, status: 'error', endedAt: Date.now() }));
        settleUser('sent');
        setStreamingContent('');
        setRunningTool(null);
        setIsStreaming(false);
        isStreamingRef.current = false;
        setCurrentToolCalls([]);
        esRef.current = null;
        fetchBalance();
        dequeueNext();
      }
    }, 10_000);

    // 打字机：AI 内容逐字显示
    const typeTimer = setInterval(() => {
      setDisplayedText((prev) => {
        const full = typewriterRef.current;
        const next = Math.min(full.length, (prev ? prev.length : 0) + 3);
        return full.slice(0, next);
      });
    }, 25);

    let accumulated = '';
    const executedToolCalls: ToolCall[] = [];

    const patchTask = (fn: (t: TaskRecord) => TaskRecord) => {
      setCurrentTask((prev) => (prev && prev.id === requestId ? fn(prev) : prev));
    };

    // 收尾：更新消息状态、关闭流、处理队列下一个
    const finish = (userStatus: Message['status']) => {
      clearInterval(watchdog);
      clearInterval(typeTimer);
      setDisplayedText(typewriterRef.current);
      settleUser(userStatus);
      setStreamingContent('');
      setRunningTool(null);
      setIsStreaming(false);
      isStreamingRef.current = false;
      setCurrentToolCalls([]);
      es.close();
      esRef.current = null;
      fetchBalance();
      dequeueNext();
    };

    es.addEventListener('message', (event) => {
      lastEventAt = Date.now();
      if (event.data === '[DONE]') {
        // 兜底：累计内容为空时用打字机缓存，避免「有回复但气泡空白」
        const finalContent = (accumulated || typewriterRef.current || '').trim();
        if (finalContent) {
          const assistantMessage: Message = {
            id: `assist-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
            role: 'assistant',
            content: finalContent,
            timestamp: Date.now(),
            toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined,
          };
          setMessages((prev) => [...prev, assistantMessage]);
        }
        patchTask((t) => ({ ...t, status: t.status === 'running' ? 'done' : t.status, endedAt: Date.now() }));
        setDisplayedText(accumulated || typewriterRef.current);
        finish('sent');
        if (autoSpeakRef.current) {
          const clean = (accumulated || typewriterRef.current).replace(/[#>*`\[\]]/g, '').slice(0, 500);
          if (clean.trim()) speakMessageRef.current?.(clean);
        }
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
              : { id: parsed.task_start.id, name: parsed.task_start.name, prompt: item.prompt, startedAt: parsed.task_start.startedAt, status: 'running', steps: [], tools: [], files: [] }
          );
        }
        if (parsed.task_step) {
          const step: TaskStep = { name: parsed.task_step.step, status: parsed.task_step.status };
          patchTask((t) => {
            const steps = [...t.steps];
            if (parsed.task_step.status === 'running') {
              steps.push(step);
            } else {
              const lastIdx = [...steps].reverse().findIndex((st) => st.name === step.name && st.status === 'running');
              if (lastIdx !== -1) steps[steps.length - 1 - lastIdx] = step;
              else steps.push(step);
            }
            return { ...t, steps };
          });
        }
        if (parsed.tool_start) {
          // 工具开始执行：立即显示「正在执行」状态
          const t = parsed.tool_start as { name?: string; args?: Record<string, unknown> };
          const args = t.args || {};
          const detail =
            (typeof args.command === 'string' && args.command) ||
            (typeof args.path === 'string' && args.path) ||
            (typeof args.query === 'string' && args.query) ||
            '';
          setRunningTool(detail ? `${t.name}: ${detail}` : (t.name || ''));
        }
        if (parsed.tool_call) {
          const rec = parsed.tool_call as TaskToolRecord;
          executedToolCalls.push(rec as unknown as ToolCall);
          setRunningTool(null);
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
          setNetworkError(false);
          accumulated += parsed.content;
          typewriterRef.current = accumulated;
        }
        if (parsed.thinking) {
          setThinking((prev) => (prev ? prev + '\n\n' : '') + String(parsed.thinking));
        }
        if (parsed.thinking_chunk) {
          // 工具轮次实时思考片段：直接拼接，不插入换行分隔
          setThinking((prev) => (prev || '') + String(parsed.thinking_chunk));
        }
        if (parsed.thinking_end) {
          // 思考流结束：去掉残留的工具 JSON 块
          setThinking((prev) => (prev || '').replace(/```tool[\s\S]*?```/g, '').trim());
        }
        if (parsed.thinking_clear) {
          // 无工具调用：清掉思考草稿，避免与最终回答重复
          setThinking('');
        }
        if (parsed.executor) {
          setExecutorLabel(typeof parsed.executor.label === 'string' ? parsed.executor.label : null);
        }
        if (parsed.permission_request) {
          setPermissionRequest(parsed.permission_request as PermissionRequest);
        }
        if (parsed.error) {
          accumulated += `\n\nError: ${parsed.error}`;
          typewriterRef.current = accumulated;
          setDisplayedText(accumulated);
        }
      } catch {
        // Ignore parse errors for non-JSON data
      }
    });

    es.addEventListener('error', () => {
      if (settled) return;
      try {
        fetch(`${API_BASE}/api/v1/chat/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId }),
        }).catch(() => {});
      } catch {}
      setDisplayedText(accumulated);
      if (accumulated) {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: accumulated + '\n\n[连接中断]',
          timestamp: Date.now(),
          status: 'error',
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } else {
        const errorMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: '无法连接到后端服务。请确认：1) 通知栏出现「本地后端服务运行中」；2) 已绑定项目；3) 稍后自动重试。',
          timestamp: Date.now(),
          status: 'error',
        };
        setMessages((prev) => [...prev, errorMessage]);
        setNetworkError(true);
      }
      patchTask((t) => ({ ...t, status: 'error', endedAt: Date.now() }));
      finish(accumulated ? 'sent' : 'error');
    });

    // 连接意外关闭（未收到 [DONE]）：结算消息状态，避免一直显示「发送中」
    es.addEventListener('close', () => {
      if (settled) return;
      setDisplayedText(typewriterRef.current);
      if (accumulated) {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: accumulated + '\n\n[连接已断开，未收到完整回复]',
          timestamp: Date.now(),
          status: 'error',
        };
        setMessages((prev) => [...prev, assistantMessage]);
      }
      patchTask((t) => ({ ...t, status: 'error', endedAt: Date.now() }));
      finish('sent');
    });
  }, [messages, currentProjectId, agentType, agentInstanceIds, dequeueNext]);

  runQueueItemRef.current = runQueueItem;

  // 入队或直接执行
  const startTask = useCallback((prompt: string, msgAttachments?: Message['attachments']) => {
    if (!prompt.trim()) return;

    const userMsgId = `user-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const userMessage: Message = {
      id: userMsgId,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
      status: isStreamingRef.current ? 'pending' : 'sending',
      attachments: msgAttachments,
      replyingTo: replyingTo
        ? { content: replyingTo.content, role: replyingTo.role }
        : undefined,
    };
    setMessages((prev) => [...prev, userMessage]);
    setInputText('');
    setReplyingTo(null);

    const item: QueueItem = {
      id: `q-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      userMsgId,
      prompt,
      replyingTo: userMessage.replyingTo,
      attachments: msgAttachments,
      isPriority: false,
      createdAt: Date.now(),
    };

    if (isStreamingRef.current) {
      queueRef.current = [...queueRef.current, item];
      setQueue(queueRef.current);
    } else {
      runQueueItem(item);
    }
  }, [replyingTo, runQueueItem]);

  // 插队：移动到队首并标记，后插的先处理
  const promoteTask = useCallback((id: string) => {
    const idx = queueRef.current.findIndex((q) => q.id === id);
    if (idx === -1) return;
    const item = { ...queueRef.current[idx], isPriority: true };
    const rest = queueRef.current.filter((_, i) => i !== idx);
    queueRef.current = [item, ...rest];
    setQueue(queueRef.current);
  }, []);

  // 取消：移出队列
  const removeTask = useCallback((id: string) => {
    queueRef.current = queueRef.current.filter((q) => q.id !== id);
    setQueue(queueRef.current);
  }, []);

  // 失败消息重试
  const retryMessage = useCallback((message: Message) => {
    setMenuMessage(null);
    if (message.role === 'user') {
      startTask(message.content, message.attachments);
    } else {
      const idx = messages.findIndex((m) => m.id === message.id);
      const prevUser = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
      if (prevUser) startTask(prevUser.content, prevUser.attachments);
    }
  }, [messages, startTask]);


  // 选择相册图片
  const pickImage = async () => {
    if (isRecording) return;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('需要相册权限', '请在系统设置中允许 Synaps 访问相册');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        allowsMultipleSelection: false,
      });
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0];
      addAttachment({
        id: `att-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        name: asset.fileName || asset.uri.split('/').pop() || 'photo.jpg',
        uri: asset.uri,
        type: 'image',
        mimeType: asset.mimeType || 'image/jpeg',
        size: asset.fileSize,
      });
    } catch (err) {
      Alert.alert('选择图片失败', String(err));
    }
  };

  // 选择文件
  const pickFile = async () => {
    if (isRecording) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0];
      addAttachment({
        id: `att-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        name: asset.name || asset.uri.split('/').pop() || 'file',
        uri: asset.uri,
        type: 'file',
        mimeType: asset.mimeType || 'application/octet-stream',
        size: asset.size,
      });
    } catch (err) {
      Alert.alert('选择文件失败', String(err));
    }
  };

  const addAttachment = (att: PendingAttachment) => {
    setAttachments((prev) => {
      if (prev.length >= 6) {
        Alert.alert('提示', '每条消息最多附带 6 个附件');
        return prev;
      }
      return [...prev, att];
    });
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // 上传附件到后端，返回服务端保存路径
  const uploadAttachments = async (list: PendingAttachment[]) => {
    const uploaded: Array<{ name: string; path: string; type: 'image' | 'file' }> = [];
    for (const att of list) {
      const form = new FormData();
      if (currentProjectId) form.append('projectId', currentProjectId);
      form.append('file', {
        uri: att.uri,
        name: att.name,
        type: att.mimeType || (att.type === 'image' ? 'image/jpeg' : 'application/octet-stream'),
      } as unknown as Blob);
      const res = await fetch(`${API_BASE}/api/v1/uploads`, { method: 'POST', body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `附件「${att.name}」上传失败`);
      }
      uploaded.push({ name: data.name || att.name, path: data.path, type: att.type });
    }
    return uploaded;
  };

  const handleSend = useCallback(async () => {
    if (!inputText.trim()) return;
    try {
      const uploaded = attachments.length ? await uploadAttachments(attachments) : [];
      const quotedText = replyingTo
        ? `> ${replyingTo.content.replace(/\n/g, '\n> ')}\n\n`
        : '';
      const attachmentText = uploaded.length
        ? '\n\n' +
          uploaded
            .map(
              (u, i) =>
                `[附件${u.type === 'image' ? '图片' : '文件'} ${i + 1}] ${u.name}（已保存到 ${u.path}，请根据需求读取并处理该附件）`
            )
            .join('\n')
        : '';
      const prompt = `${quotedText}${inputText.trim()}${attachmentText}`;
      const msgAttachments = attachments.map((a, i) => ({
        name: a.name,
        path: uploaded[i]?.path || '',
        uri: a.uri,
        type: a.type,
      }));
      startTask(prompt, msgAttachments);
      setAttachments([]);
    } catch (err) {
      Alert.alert('发送失败', err instanceof Error ? err.message : String(err));
    }
  }, [inputText, replyingTo, attachments, currentProjectId, startTask]);

  // 一键对话模板：直接发起任务
  const sendTemplate = useCallback(
    (prompt: string) => {
      if (isStreamingRef.current) return;
      startTask(prompt);
    },
    [startTask]
  );

  // 取消当前任务
  const cancelTask = useCallback(() => {
    const requestId = requestIdRef.current;
    if (requestId) {
      fetch(`${API_BASE}/api/v1/chat/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      }).catch(() => undefined);
    }
    if (esRef.current) esRef.current.close();
    const uid = currentUserMsgIdRef.current;
    if (uid) {
      setMessages((prev) => prev.map((m) => (m.id === uid ? { ...m, status: 'cancelled' } : m)));
    }
    setCurrentTask((t) => (t ? { ...t, status: 'cancelled', endedAt: Date.now() } : t));
    setIsStreaming(false);
    isStreamingRef.current = false;
    setStreamingContent('');
    esRef.current = null;
    dequeueNext();
  }, [dequeueNext]);

  // 重跑：以相同指令重新发起任务
  const rerunTask = useCallback(() => {
    const task = currentTask;
    if (!task) return;
    startTask(task.prompt);
  }, [currentTask, startTask]);

  // 回滚：恢复任务开始前的最新快照，并向对话流插入回滚记录
  const doRollback = useCallback(async () => {
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

  const rollbackTask = useCallback(async () => {
    const task = currentTask;
    if (!task || !currentProjectId) return;
    Alert.alert('确认回滚', `将恢复任务「${task.name}」开始前的最新快照，确定吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '回滚', style: 'destructive', onPress: doRollback },
    ]);
  }, [currentTask, currentProjectId, doRollback]);

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
    if (!text.trim()) return;
    Speech.speak(text, {
      language: 'zh-CN',
      pitch: 1.0,
      rate: 1.0,
    });
  }, []);

  const toggleAutoSpeak = useCallback(() => {
    setAutoSpeak((prev) => {
      const next = !prev;
      autoSpeakRef.current = next;
      if (!next) Speech.stop();
      return next;
    });
  }, []);

  speakMessageRef.current = speakMessage;

  const closeMessageMenu = useCallback(() => {
    setMenuMessage(null);
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (Keyboard.isVisible()) {
        Keyboard.dismiss();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    cursorShared.value = withRepeat(
      withSequence(
        withTiming(0.15, { duration: 420, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 420, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
    return () => cancelAnimation(cursorShared);
  }, [cursorShared]);

  // Thinking 组件：脉冲呼吸动画
  useEffect(() => {
    thinkingPulse.value = withRepeat(
      withSequence(
        withTiming(0.35, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
    return () => cancelAnimation(thinkingPulse);
  }, [thinkingPulse]);

  const openMessageMenu = useCallback((message: Message) => {
    Vibration.vibrate(10);
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

  const deleteMessage = useCallback(
    (message: Message) => {
      Alert.alert('确认删除', '确定要删除这条消息吗？', [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            setMessages((prev) => prev.filter((m) => m.id !== message.id));
            closeMessageMenu();
          },
        },
      ]);
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
      const trustThisProject = trustProjectChecked;
      setPermissionRequest(null);
      setTrustProjectChecked(false);
      try {
        const res = await fetch(`${API_BASE}/api/v1/chat/approval`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId: request.id,
            approved,
            trustProject: approved && trustThisProject && currentProjectId ? true : false,
          }),
        });
        if (!res.ok) {
          Toast.show({ type: 'error', text1: '审批已过期，请重试' });
        }
      } catch {
        Toast.show({ type: 'error', text1: '审批提交失败' });
      }
    },
    [permissionRequest, trustProjectChecked, currentProjectId]
  );

  const renderMessage = useCallback(({ item }: { item: Message }) => {
    const isUser = item.role === 'user';
    return (
      <Animated.View {...messageEntry} style={[styles.messageRow, isUser ? styles.messageRowUser : styles.messageRowAssistant]}>
        <Pressable
          onLongPress={() => openMessageMenu(item)}
          delayLongPress={350}
          style={[
            styles.messageBubblePressable,
            isUser ? styles.messageBubblePressableUser : styles.messageBubblePressableAssistant,
          ]}
        >
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
          {isUser ? (
            <Text style={[styles.messageContent, styles.messageContentUser]}>{item.content}</Text>
          ) : (
            <RichContent content={item.content} isUser={false} colors={colors} styles={styles} />
          )}
          {item.attachments && item.attachments.length > 0 && (
            <View style={styles.msgAttachments}>
              {item.attachments.map((att, idx) =>
                att.type === 'image' && att.uri ? (
                  <Pressable key={idx} onPress={() => att.uri && setPreviewImage(att.uri)} style={styles.msgAttachmentImageWrapper}>
                    <Image source={{ uri: att.uri }} style={styles.msgAttachmentImage} resizeMode="cover" />
                    <FontAwesome6 name="expand" size={13} color={colors.textMuted} style={styles.imageExpandIcon} />
                  </Pressable>
                ) : (
                  <View key={idx} style={styles.msgAttachmentFile}>
                    <FontAwesome6 name="paperclip" size={11} color={colors.textSecondary} />
                    <Text style={styles.msgAttachmentFileName} numberOfLines={1}>
                      {att.name}
                    </Text>
                  </View>
                )
              )}
            </View>
          )}
          {item.toolCalls && item.toolCalls.length > 0 && (
            <View style={styles.toolCallsContainer}>
              <Text style={styles.toolCallsLabel}>Tools executed:</Text>
              {item.toolCalls.map((tc, idx) => {
                const command =
                  typeof tc.args?.command === 'string' ? tc.args.command : '';
                const exitMatch = tc.result?.match(/exit (\d+)/);
                const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
                const failed = exitCode !== null && exitCode !== 0;
                const durMatch = tc.result?.match(/\((\d+)ms/);
                const durationMs = durMatch ? parseInt(durMatch[1], 10) : null;
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
                      <AppIcon name={toolIcon(tc.name)} size={11} color={colors.textSecondary} />
                      <Text style={styles.toolCallName}>{tc.name}</Text>
                      {durationMs !== null && (
                        <Text style={styles.toolCallDuration}>{durationMs}ms</Text>
                      )}
                      {exitCode !== null && (
                        <View style={[styles.toolCallStatus, failed && styles.toolCallStatusError]}>
                          <FontAwesome6
                            name={failed ? 'xmark' : 'check'}
                            size={9}
                            color={failed ? colors.error : colors.success}
                          />
                          <Text
                            style={[
                              styles.toolCallStatusText,
                              failed && styles.toolCallStatusTextError,
                            ]}
                          >
                            {failed ? `失败 ${exitCode}` : '成功'}
                          </Text>
                        </View>
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
        {(isUser && item.status && item.status !== 'sent') && (
          <View style={styles.messageStatusRow}>
            {item.status === 'pending' && <Text style={styles.messageStatusPending}>排队中</Text>}
            {item.status === 'sending' && <Text style={styles.messageStatusPending}>发送中...</Text>}
            {item.status === 'error' && <Text style={styles.messageStatusError}>发送失败 · 长按重试</Text>}
            {item.status === 'cancelled' && <Text style={styles.messageStatusPending}>已取消</Text>}
          </View>
        )}
        <Text style={styles.messageTime}>{formatRelativeTime(item.timestamp)}</Text>
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
  const showBackendInfo = useCallback(async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${API_BASE}/api/v1/diagnostics`, { signal: ctrl.signal });
      clearTimeout(t);
      const data = await res.json();
      const b = (data && data.backend) || {};
      const detail = [
        `状态：${b.status === 'ok' ? '已连接' : '异常'}`,
        `地址：${API_BASE}`,
        `端口：${b.port ?? '-'}`,
        `运行：${b.uptimeSec ?? '-'}s`,
        `Node：${b.nodeVersion || '-'}`,
        `架构：${b.arch || '-'}`,
      ].join('\n');
      Alert.alert('后端状态', detail);
    } catch {
      Alert.alert('后端状态', `未连接（${API_BASE}）\n请确认本地后端服务已启动，或到设置查看诊断`);
    }
  }, []);

  const clearHistory = useCallback(() => {
    Alert.alert('确认清空', '确定要清空当前对话历史吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          setMessages([]);
          Toast.show({ type: 'success', text1: '对话历史已清空' });
        },
      },
    ]);
  }, []);


  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle={isDark ? 'light' : 'dark'} safeAreaEdges={['top', 'left', 'right']} scrollable>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <View style={styles.panes}>
        <View style={[styles.leftPane, isSideBySide && styles.leftPaneWide]}>
        {/* Header */}
        <View style={styles.header}>
          <MenuButton onPress={onOpenSidebar} />
          <View style={styles.headerCenter} pointerEvents="none">
            <Text style={styles.headerTitle}>Agent</Text>
          </View>
          <View style={styles.headerRight}>
            <Pressable
              style={styles.backendChip}
              onPress={showBackendInfo}
              hitSlop={6}
            >
              <View
                style={[
                  styles.backendChipDot,
                  backendOnline === null
                    ? styles.backendStatusDotConnecting
                    : backendOnline
                      ? styles.backendStatusDotOnline
                      : styles.backendStatusDotOffline,
                ]}
              />
              <Text style={styles.backendChipText} numberOfLines={1}>
                {backendOnline === null ? '后端' : backendOnline ? '后端' : '离线'}
              </Text>
            </Pressable>
            <Pressable style={styles.headerAction} onPress={() => setTaskPanelVisible(!taskPanelVisible)}>
              <PanelToggleIcon
                open={taskPanelVisible}
                sideBySide={isSideBySide}
                color={taskPanelVisible ? colors.primary : colors.textSecondary}
              />
            </Pressable>
          <Pressable style={styles.headerAction} onPress={clearHistory} hitSlop={6}>
              <FontAwesome6 name="trash" size={16} color={colors.textSecondary} />
            </Pressable>
          </View>
        </View>

        {/* API Key 引导条 */}
        {hasApiKey === false && (
          <Pressable style={styles.onboardBar} onPress={onOpenSidebar}>
            <FontAwesome6 name="circle-exclamation" size={13} color="#FFFFFF" />
            <Text style={styles.onboardBarText} numberOfLines={2}>
              尚未配置 API Key，Agent 无法工作 → 去设置填写
            </Text>
          </Pressable>
        )}

        {/* 项目行（绑定项目用） */}
        <Pressable style={styles.contextBar} onPress={openProjectPicker} hitSlop={4}>
          <FontAwesome6
            name="folder-open"
            size={13}
            color={currentProjectId ? colors.primary : colors.warning}
          />
          <Text style={styles.contextProjectText} numberOfLines={1}>
            {currentProjectId
              ? currentProjectName || '项目已绑定'
              : '选择项目'}
          </Text>
          <FontAwesome6 name="chevron-down" size={9} color={colors.textMuted} />
        </Pressable>

        {/* 搜索栏 */}
        {searchVisible && (
          <View style={styles.searchBar}>
            <FontAwesome6 name="magnifying-glass" size={14} color={colors.textSecondary} />
            <TextInput
              style={styles.searchInput}
              placeholder="搜索对话历史..."
              placeholderTextColor={colors.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
            />
            {searchQuery && (
              <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
                <FontAwesome6 name="xmark" size={14} color={colors.textMuted} />
              </Pressable>
            )}
            <Pressable onPress={() => setSearchVisible(false)} hitSlop={8}>
              <FontAwesome6 name="xmark" size={14} color={colors.textSecondary} />
            </Pressable>
          </View>
        )}

        {/* 精简任务卡片（细进度条，点击展开面板） */}
        {currentTask && (
          <Animated.View {...cardEntry}>
            <PressableScale style={styles.taskCard} onPress={() => setTaskPanelVisible(true)}>
              <View style={styles.taskCardHeader}>
                <AppIcon name="list-checks" size={13} color={colors.textSecondary} />
                <Text style={styles.taskCardName} numberOfLines={1}>{currentTask.name}</Text>
                <View style={[styles.taskCardStatusPill, currentTask.status === 'error' && styles.taskCardStatusPillError]}>
                  {currentTask.status === 'running' ? (
                    <FontAwesome6 name="spinner" size={9} color={colors.textSecondary} spin />
                  ) : currentTask.status === 'done' ? (
                    <FontAwesome6 name="check" size={9} color={colors.success} />
                  ) : currentTask.status === 'error' ? (
                    <FontAwesome6 name="xmark" size={9} color={colors.error} />
                  ) : (
                    <FontAwesome6 name="circle-minus" size={9} color={colors.textMuted} />
                  )}
                  <Text style={[styles.taskCardStatus, currentTask.status === 'error' && styles.taskCardStatusError]}>
                    {currentTask.status === 'running' ? '执行中' : currentTask.status === 'done' ? '已完成' : currentTask.status === 'cancelled' ? '已取消' : '出错'}
                  </Text>
                </View>
              </View>
              {executorLabel ? (
                <Text style={styles.taskCardExecutor} numberOfLines={1}>
                  ⚙ {executorLabel}
                </Text>
              ) : null}
              <AnimatedProgressBar
                progress={
                  currentTask.steps.length > 0
                    ? currentTask.steps.filter((st) => st.status === 'done' || st.status === 'error').length / currentTask.steps.length
                    : currentTask.status === 'running' ? 0.08 : 1
                }
                color={colors.primary}
                trackColor={colors.bgInput}
                height={3}
              />
            </PressableScale>
          </Animated.View>
        )}

        {/* 消息队列（等待中，一行显示，点击管理） */}
        {queue.length > 0 && (
          <Pressable style={styles.queueBar} onPress={() => setQueueManagerVisible(true)}>
            <Text style={styles.queueBarText} numberOfLines={1}>
              ⏳ {queue.length} 条等待中（{queue.filter((q) => q.isPriority).length} 条插队）
            </Text>
            <Text style={styles.queueBarHint}>管理</Text>
          </Pressable>
        )}

        {/* Messages */}
        <FlatList
          ref={flatListRef}
          data={filteredMessages}
          renderItem={renderMessage}
          keyExtractor={(item) => item.id}
          style={styles.messageList}
          contentContainerStyle={[
            styles.messageContentArea,
            { paddingBottom: spacing.lg },
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
            ) : currentProjectId ? (
              <View style={styles.emptyState}>
                <Image
                  source={require('@/assets/images/avatar.png')}
                  style={styles.emptyLogoImage}
                />
                <Text style={styles.emptyTitle}>SYNAPS AGENT</Text>
                <Text style={styles.emptyDesc}>
                  开始你的第一次对话{''}
                  {'\n'}告诉我你想开发或修复什么
                </Text>
                <View style={styles.templateRow}>
                  {TEMPLATES.map((t) => (
                    <Pressable key={t.label} style={styles.templateChip} onPress={() => sendTemplate(t.prompt)}>
                      <Text style={styles.templateChipText}>{t.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : (
              <View style={styles.emptyState}>
                <FontAwesome6 name="folder-plus" size={48} color={colors.textMuted} />
                <Text style={styles.emptyTitle}>还没有项目</Text>
                <Text style={styles.emptyDesc}>
                  点击右上角 + 创建项目，或去「项目」模块新建
                </Text>
                <Pressable style={styles.createProjectBtn} onPress={openProjectPicker}>
                  <Text style={styles.createProjectBtnText}>+ 创建项目</Text>
                </Pressable>
              </View>
            )
          }
          ListFooterComponent={
            isStreaming ? (
              <>
              {thinking ? (
                <View style={styles.thinkingInline}>
                  <Pressable style={styles.thinkingInlineHeader} onPress={() => setThinkingOpen(!thinkingOpen)}>
                    <Animated.View style={thinkingPulseStyle}>
                      <FontAwesome6 name="brain" size={10} color={colors.textMuted} />
                    </Animated.View>
                    <Text style={styles.thinkingInlineLabel}>思考</Text>
                    <Text style={styles.thinkingInlinePreview} numberOfLines={1}>
                      {thinkingOpen ? '' : thinking.replace(/\n/g, ' ').slice(0, 50) + '…'}
                    </Text>
                    <FontAwesome6
                      name={thinkingOpen ? 'chevron-up' : 'chevron-down'}
                      size={9}
                      color={colors.textMuted}
                    />
                  </Pressable>
                  {thinkingOpen && (
                    <Text style={styles.thinkingInlineBody} numberOfLines={20} selectable>
                      {thinking}
                    </Text>
                  )}
                </View>
              ) : null}
              {streamingContent ? (
                <View style={[styles.messageRow, styles.messageRowAssistant]}>
                  <View style={[styles.messageBubble, styles.assistantBubble, styles.streamBubble]}>
                    <Text style={styles.messageContent}>
                      {stripDiagramMarkup(displayedText)}
                      <Animated.Text style={[styles.streamCursor, cursorStyle]}>▍</Animated.Text>
                    </Text>
                    {currentToolCalls.length > 0 && (
                      <View style={styles.toolCallsContainer}>
                        {currentToolCalls.map((tc, idx) => {
                          const command =
                            typeof tc.args?.command === 'string' ? tc.args.command : '';
                          return (
                            <View key={idx} style={styles.toolCallBadge}>
                              <ToolSpinner size={13} color={colors.primary} />
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
              ) : thinking ? null : (
                <View style={[styles.messageRow, styles.messageRowAssistant]}>
                  <View style={[styles.messageBubble, styles.assistantBubble, styles.streamBubble]}>
                    {runningTool ? (
                      <View style={styles.thinkingInlineHeader}>
                        <ToolSpinner size={12} color={colors.primary} />
                        <Text style={styles.thinkingInlineLabel}>执行：{runningTool}</Text>
                      </View>
                    ) : (
                      <View style={styles.thinkingInlineHeader}>
                        <ThinkingDots color={colors.primary} size={5} />
                        <Text style={styles.thinkingInlineLabel}>思考中...</Text>
                      </View>
                    )}
                  </View>
                </View>
              )}
              </>
            ) : null
          }
        />

        {/* Input */}
        <View
          style={[styles.inputContainer, { paddingBottom: keyboardShown ? spacing.md : insets.bottom + spacing.md }]}
        >
          {networkError && (
            <View style={styles.networkBanner}>
              <FontAwesome6 name="wifi" size={11} color="#FFFFFF" />
              <Text style={styles.networkBannerText}>网络不可用，请检查连接后重试</Text>
            </View>
          )}
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
                <FontAwesome6 name="xmark" size={13} color={colors.textSecondary} />
              </Pressable>
            </View>
          )}
          {attachments.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.attachChips}
              contentContainerStyle={styles.attachChipsContent}
              keyboardShouldPersistTaps="handled"
            >
              {attachments.map((att) => (
                <View key={att.id} style={styles.attachChip}>
                  {att.type === 'image' ? (
                    <Image source={{ uri: att.uri }} style={styles.attachChipThumb} />
                  ) : (
                    <View style={styles.attachChipIcon}>
                      <FontAwesome6 name="paperclip" size={11} color={colors.textSecondary} />
                    </View>
                  )}
                  <Text style={styles.attachChipName} numberOfLines={1}>
                    {att.name}
                  </Text>
                  <Pressable onPress={() => removeAttachment(att.id)} hitSlop={8} style={styles.attachChipRemove}>
                    <FontAwesome6 name="xmark" size={10} color={colors.textSecondary} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
          <View style={styles.inputRow}>
            <Text style={styles.inputPromptPrefix}>{'>'}</Text>
            <TextInput
              style={styles.textInput}
              placeholder="输入指令..."
              placeholderTextColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}
              value={inputText}
              onChangeText={setInputText}
              multiline
              numberOfLines={1}
              maxLength={2000}
              editable={!isRecording}
              returnKeyType="default"
              blurOnSubmit={false}
              onKeyPress={(e: any) => {
                if (e.nativeEvent?.key === 'Enter' && !e.nativeEvent?.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <Pressable
              style={[styles.sendButton, inputText.trim() ? styles.sendButtonActive : styles.sendButtonDisabled]}
              onPress={handleSend}
              disabled={!inputText.trim()}
            >
              <FontAwesome6
                name={isStreaming ? 'spinner' : 'paper-plane'}
                size={13}
                color={(!inputText.trim() || isStreaming) ? colors.textMuted : (isDark ? '#0D0D0D' : '#FFFFFF')}
                spin={isStreaming}
                weight={400}
              />
            </Pressable>
          </View>

          {/* Bottom toolbar: model + agent + actions */}
          <View style={styles.inputBottomBar}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.inputBottomBarContent}
              keyboardShouldPersistTaps="handled"
            >
              {/* Model switcher */}
              <Pressable
                style={styles.inputBottomPill}
                onPress={switchModel}
                disabled={isStreaming || isRecording}
              >
                <FontAwesome6 name="microchip" size={8} color={colors.textMuted} />
                <Text style={styles.inputBottomPillText} numberOfLines={1}>{modelLabel}</Text>
              </Pressable>

              {AGENT_OPTIONS.map((opt) => {
                const active = agentType === opt.key;
                return (
                  <Pressable
                    key={opt.key}
                    style={[styles.inputBottomChip, active && styles.inputBottomChipActive]}
                    onPress={() => switchAgent(opt.key)}
                  >
                    <FontAwesome6 name={opt.icon} size={8} color={active ? (isDark ? '#0D0D0D' : '#FFFFFF') : colors.textMuted} />
                    <Text style={[styles.inputBottomChipText, active && styles.inputBottomChipTextActive]}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <View style={styles.inputBottomActions}>
              <Pressable style={styles.inputBottomIconBtn} onPress={() => setAttachMenuVisible(true)} hitSlop={6}>
                <FontAwesome6 name="paperclip" size={12} color={colors.textMuted} />
              </Pressable>
              <Pressable
                style={styles.inputBottomIconBtn}
                onPress={isRecording ? stopRecording : startRecording}
                disabled={isStreaming}
              >
                <FontAwesome6
                  name={isRecording ? 'stop' : 'microphone'}
                  size={12}
                  color={isRecording ? '#EF4444' : colors.textMuted}
                />
              </Pressable>
              <Pressable
                style={styles.inputBottomIconBtn}
                onPress={toggleAutoSpeak}
              >
                <FontAwesome6
                  name={autoSpeak ? 'volume-high' : 'volume-xmark'}
                  size={12}
                  color={autoSpeak ? colors.textPrimary : colors.textMuted}
                />
              </Pressable>
            </View>
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
              executorLabel={executorLabel}
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
                  executorLabel={executorLabel}
                  onCancel={cancelTask}
                  onRerun={rerunTask}
                  onRollback={rollbackTask}
                />
              </View>
            </View>
          </Modal>
        )}

        {/* 附件选择菜单（+ 号） */}
        <Modal
          visible={attachMenuVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setAttachMenuVisible(false)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setAttachMenuVisible(false)}>
            <Pressable
              style={[styles.modalContainer, styles.messageMenuContainer, { paddingBottom: spacing.lg }]}
              onPress={() => {}}
            >
              <Text style={[styles.modalTitle, styles.messageMenuTitle]}>添加附件</Text>
              <Pressable
                style={styles.messageMenuItem}
                onPress={() => {
                  setAttachMenuVisible(false);
                  pickImage();
                }}
              >
                <FontAwesome6 name="image" size={13} color={colors.primary} />
                <Text style={styles.messageMenuItemText}>从相册选择图片</Text>
              </Pressable>
              <Pressable
                style={styles.messageMenuItem}
                onPress={() => {
                  setAttachMenuVisible(false);
                  pickFile();
                }}
              >
                <FontAwesome6 name="file" size={13} color={colors.primary} />
                <Text style={styles.messageMenuItemText}>选择文件</Text>
              </Pressable>
              <Pressable
                style={[styles.messageMenuItem, styles.messageMenuItemCancel]}
                onPress={() => setAttachMenuVisible(false)}
              >
                <Text style={styles.messageMenuItemCancelText}>取消</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        {/* Message action menu */}
        <Modal
          visible={!!menuMessage}
          transparent
          animationType="fade"
          onRequestClose={closeMessageMenu}
        >
          <Pressable style={styles.modalOverlay} onPress={closeMessageMenu}>
            <Pressable
              style={[styles.modalContainer, styles.messageMenuContainer, { paddingBottom: spacing.lg }]}
              onPress={() => {}}
            >
              <Text style={[styles.modalTitle, styles.messageMenuTitle]}>消息操作</Text>
              <Pressable
                style={styles.messageMenuItem}
                onPress={() => menuMessage && copyMessage(menuMessage)}
              >
                <FontAwesome6 name="copy" size={13} color={colors.primary} />
                <Text style={styles.messageMenuItemText}>复制</Text>
              </Pressable>
              <Pressable
                style={styles.messageMenuItem}
                onPress={() => menuMessage && quoteMessage(menuMessage)}
              >
                <FontAwesome6 name="quote-left" size={13} color={colors.primary} />
                <Text style={styles.messageMenuItemText}>引用回复</Text>
              </Pressable>
              <Pressable
                style={styles.messageMenuItem}
                onPress={() => menuMessage && speakMessage(menuMessage.content)}
              >
                <FontAwesome6 name="volume-high" size={13} color={colors.primary} />
                <Text style={styles.messageMenuItemText}>朗读</Text>
              </Pressable>
              <Pressable
                style={styles.messageMenuItem}
                onPress={() => menuMessage && shareMessage(menuMessage)}
              >
                <FontAwesome6 name="share-nodes" size={13} color={colors.primary} />
                <Text style={styles.messageMenuItemText}>分享</Text>
              </Pressable>
              {menuMessage?.status === 'error' && (
                <Pressable
                  style={styles.messageMenuItem}
                  onPress={() => menuMessage && retryMessage(menuMessage)}
                >
                  <FontAwesome6 name="rotate-right" size={13} color={colors.warning} />
                  <Text style={styles.messageMenuItemText}>重试</Text>
                </Pressable>
              )}
              {menuMessage?.status === 'error' && (
                <Pressable
                  style={styles.messageMenuItem}
                  onPress={() => menuMessage && retryMessage(menuMessage)}
                >
                  <FontAwesome6 name="rotate-right" size={13} color={colors.warning} />
                  <Text style={styles.messageMenuItemText}>重试</Text>
                </Pressable>
              )}
              <Pressable
                style={styles.messageMenuItem}
                onPress={() => menuMessage && deleteMessage(menuMessage)}
              >
                <FontAwesome6 name="trash" size={13} color={colors.error} />
                <Text style={styles.messageMenuItemText}>删除消息</Text>
              </Pressable>
              <Pressable style={[styles.messageMenuItem, styles.messageMenuItemCancel]} onPress={closeMessageMenu}>
                <Text style={styles.messageMenuItemCancelText}>取消</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        {/* 队列操作菜单 */}
        <Modal
          visible={!!queueMenu}
          transparent
          animationType="fade"
          onRequestClose={() => setQueueMenu(null)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setQueueMenu(null)}>
            <Pressable
              style={[styles.modalContainer, { paddingBottom: spacing.xl + insets.bottom }]}
              onPress={() => {}}
            >
              <Text style={styles.modalTitle}>队列消息</Text>
              <Text style={styles.queueMenuPreview} numberOfLines={2}>
                {queueMenu?.prompt}
              </Text>
              <Pressable
                style={styles.modalItem}
                onPress={() => {
                  if (queueMenu) promoteTask(queueMenu.id);
                  setQueueMenu(null);
                }}
              >
                <FontAwesome6 name="arrow-up" size={14} color={colors.warning} />
                <Text style={styles.modalItemText}>插队（下一条处理）</Text>
              </Pressable>
              <Pressable
                style={styles.modalItem}
                onPress={() => {
                  if (queueMenu) removeTask(queueMenu.id);
                  setQueueMenu(null);
                }}
              >
                <FontAwesome6 name="trash" size={14} color={colors.error} />
                <Text style={styles.modalItemText}>取消（移出队列）</Text>
              </Pressable>
              <Pressable style={[styles.modalItem, styles.modalItemCancel]} onPress={() => setQueueMenu(null)}>
                <Text style={styles.modalItemCancelText}>取消</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        {/* 队列管理面板 */}
        <Modal
          visible={queueManagerVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setQueueManagerVisible(false)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setQueueManagerVisible(false)}>
            <View style={[styles.queueManagerSheet, { paddingBottom: insets.bottom + spacing.md }]}>
              <View style={styles.queueManagerHeader}>
                <Text style={styles.modalTitle}>消息队列</Text>
                <Text style={styles.queueManagerCount}>
                  {queue.length} 条等待中 · {queue.filter((q) => q.isPriority).length} 条插队
                </Text>
              </View>
              {queue.length === 0 ? (
                <Text style={styles.queueManagerEmpty}>队列为空</Text>
              ) : (
                queue.map((item) => (
                  <View key={item.id} style={styles.queueManagerItem}>
                    <Text style={styles.queueManagerName} numberOfLines={1}>
                      {item.isPriority ? '🔝 ' : ''}
                      {item.prompt.replace(/\n/g, ' ')}
                    </Text>
                    <Pressable style={styles.queueManagerBtn} onPress={() => promoteTask(item.id)} hitSlop={6}>
                      <FontAwesome6 name="arrow-up" size={11} color={colors.warning} />
                      <Text style={[styles.queueManagerBtnText, { color: colors.warning }]}>插队</Text>
                    </Pressable>
                    <Pressable style={styles.queueManagerBtn} onPress={() => removeTask(item.id)} hitSlop={6}>
                      <FontAwesome6 name="trash" size={11} color={colors.error} />
                      <Text style={[styles.queueManagerBtnText, { color: colors.error }]}>移除</Text>
                    </Pressable>
                  </View>
                ))
              )}
              <Pressable style={[styles.modalItem, styles.modalItemCancel]} onPress={() => setQueueManagerVisible(false)}>
                <Text style={styles.modalItemCancelText}>关闭</Text>
              </Pressable>
            </View>
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
                    <FontAwesome6 name="check" size={13} color={colors.success} />
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

        {/* Image Preview Modal */}
        <Modal visible={!!previewImage} transparent animationType="fade" onRequestClose={() => setPreviewImage(null)}>
          <Pressable onPress={() => setPreviewImage(null)} style={styles.previewOverlay}>
            {previewImage && <Image source={{ uri: previewImage }} style={styles.previewImage} resizeMode="contain" />}
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
                  color={colors.textSecondary}
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
              {currentProjectId ? (
                <Pressable
                  style={styles.permissionTrustRow}
                  onPress={() => setTrustProjectChecked((v) => !v)}
                  hitSlop={6}
                >
                  <View
                    style={[
                      styles.permissionCheckbox,
                      trustProjectChecked && styles.permissionCheckboxChecked,
                    ]}
                  >
                    {trustProjectChecked && (
                      <FontAwesome6 name="check" size={10} color="#FFFFFF" />
                    )}
                  </View>
                  <Text style={styles.permissionTrustText}>
                    信任该项目，之后的操作不再确认
                  </Text>
                </Pressable>
              ) : null}
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
                  <Text style={styles.permissionBtnAllowText}>通过</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const createStyles = (colors: ThemeColors, isDark: boolean) => StyleSheet.create({
  panes: {
    flex: 1,
    flexDirection: 'row',
  },
  leftPane: {
    flexDirection: 'column',
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
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    gap: 4,
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
  taskCardExecutor: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 2,
    marginBottom: 4,
  },
  taskCardStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(85,85,85,0.10)',
  },
  taskCardStatusPillError: {
    backgroundColor: 'rgba(244,67,54,0.12)',
  },
  taskCardStatus: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  taskCardStatusError: {
    color: colors.error,
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
    paddingBottom: spacing.sm,
  },
  headerCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // headerCenter 是绝对定位（不占宽度），不加 auto 会把右侧元素挤到三条杠旁边
    marginLeft: 'auto',
  },
  headerTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  rechargeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
  },
  rechargeText: {
    fontSize: fontSize.xs,
    color: '#FFFFFF',
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
  backendChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  backendChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  backendChipText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '600',
    maxWidth: 48,
  },

  onboardBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: 'rgba(245,158,11,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.4)',
    borderRadius: radius.md,
  },
  onboardBarText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.warning,
    fontWeight: '600',
  },
  contextBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: 'rgba(85,85,85,0.06)',
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  contextProjectText: {
    flex: 1,
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    paddingVertical: 4,
  },
  agentStrip: {
    display: 'none',
  },
  agentStripContent: {
    gap: 3,
    paddingRight: 4,
  },
  agentStripChip: {
    display: 'none',
  },
  agentStripChipActive: {
    display: 'none',
  },
  agentStripText: {
    display: 'none',
  },
  agentStripTextActive: {
    display: 'none',
  },
  messageList: {
    flex: 1,
  },
  messageContentArea: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  messageRow: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  messageRowUser: {
    alignItems: 'flex-end',
  },
  messageRowAssistant: {
    alignItems: 'flex-start',
  },
  messageBubblePressable: {
    maxWidth: '90%',
  },
  messageBubblePressableUser: {
    alignSelf: 'flex-end',
    maxWidth: '80%',
  },
  messageBubblePressableAssistant: {
    alignSelf: 'flex-start',
  },
  messageBubble: {
    borderRadius: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
  },
  userBubble: {
    backgroundColor: colors.primaryDark,
    borderBottomRightRadius: 4,
  },
  streamBubble: {
    maxWidth: '90%',
  },
  assistantBubble: {
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  thinkingBubble: {
    display: 'none',
  },
  thinkingText: {
    display: 'none',
  },
  messageContent: {
    fontSize: fontSize.md,
    color: colors.textPrimary,
    lineHeight: 22,
    flexShrink: 1,
  },
  messageContentUser: {
    color: '#FFFFFF',
  },
  /* ---- AI-Native UI：代码块卡片 ---- */
  codeCard: {
    marginTop: spacing.sm,
    backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  codeCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    backgroundColor: isDark ? '#242424' : '#E8E8E8',
  },
  codeCardLang: {
    fontSize: 10,
    color: colors.textSecondary,
    fontWeight: '600',
    textTransform: 'lowercase',
  },
  codeCardCopy: {
    fontSize: 10,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  codeCardBody: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    lineHeight: 16,
    color: colors.textPrimary,
    padding: spacing.sm,
  },
  /* ---- AI-Native UI：洞察卡片 ---- */
  insightCard: {
    marginTop: spacing.sm,
    backgroundColor: isDark ? '#1A1A1A' : '#F5F5F5',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: 4,
  },
  insightCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  insightCardTitle: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '700',
  },
  insightCardBody: {
    fontSize: fontSize.xs,
    color: colors.textPrimary,
    lineHeight: 17,
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
  toolCallDuration: {
    fontSize: 9,
    color: colors.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  toolCallStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: 'rgba(76,175,80,0.12)',
  },
  toolCallStatusError: {
    backgroundColor: 'rgba(244,67,54,0.12)',
  },
  toolCallStatusText: {
    fontSize: 9,
    color: colors.success,
    fontWeight: '700',
  },
  toolCallStatusTextError: {
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
  emptyLogoImage: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
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
  createProjectBtn: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  createProjectBtnText: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  templateRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  templateChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  templateChipText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: '600',
  },
  inputContainer: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    paddingTop: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bgRoot,
  },
  inputTopBar: {
    display: 'none',
  },
  inputModelPill: {
    display: 'none',
  },
  inputModelText: {
    display: 'none',
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    marginBottom: spacing.xs,
  },
  replyBarLine: {
    width: 2,
    alignSelf: 'stretch',
    borderRadius: 1,
    backgroundColor: colors.textMuted,
  },
  replyBarContent: {
    flex: 1,
  },
  replyBarLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.5,
  },
  replyBarText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    marginTop: 1,
  },
  replyBarClose: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 0,
  },
  inputPromptPrefix: {
    fontSize: 15,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: colors.textMuted,
    lineHeight: 22,
    paddingTop: 12,
    paddingLeft: 4,
    paddingRight: 2,
    includeFontPadding: false,
  },
  textInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 15,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    paddingVertical: 10,
    maxHeight: 140,
    minHeight: 44,
    textAlignVertical: 'top',
    lineHeight: 22,
    paddingHorizontal: 2,
  },
  inputActions: {
    display: 'none',
  },
  inputIconBtn: {
    display: 'none',
  },
  sendButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonActive: {
    backgroundColor: isDark ? '#FFFFFF' : '#1A1A1A',
  },
  sendButtonDisabled: {
    backgroundColor: 'transparent',
  },
  inputBottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 6,
  },
  inputBottomBarContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingRight: 4,
  },
  inputBottomPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    height: 22,
    borderRadius: 11,
    backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
    flexShrink: 0,
  },
  inputBottomPillText: {
    fontSize: 9,
    color: colors.textMuted,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  inputBottomChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    height: 20,
    borderRadius: 10,
    backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
    flexShrink: 0,
  },
  inputBottomChipActive: {
    backgroundColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.10)',
  },
  inputBottomChipText: {
    fontSize: 8,
    color: colors.textMuted,
    fontWeight: '500',
  },
  inputBottomChipTextActive: {
    color: colors.textPrimary,
    fontWeight: '600',
  },
  inputBottomActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
  },
  inputBottomIconBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputHint: {
    fontSize: 10,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  voiceButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceButtonActive: {
    backgroundColor: 'rgba(239,68,68,0.15)',
  },
  modelButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 22,
    borderRadius: 11,
    backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
    paddingHorizontal: 8,
    display: 'none',
  },
  modelButtonText: {
    fontSize: 10,
    color: colors.textMuted,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  footerIconBtn: {
    display: 'none',
  },
  attachButton: {
    display: 'none',
  },
  attachChips: {
    marginBottom: spacing.sm,
    flexGrow: 0,
  },
  attachChipsContent: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  attachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingLeft: 4,
    paddingRight: 8,
    paddingVertical: 4,
    maxWidth: 180,
  },
  attachChipThumb: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
  },
  attachChipIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  attachChipName: {
    flexShrink: 1,
    fontSize: fontSize.xs,
    color: colors.textSecondary,
  },
  attachChipRemove: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  msgAttachments: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  msgAttachmentImage: {
    width: 96,
    height: 96,
    borderRadius: radius.md,
  },
  msgAttachmentImageWrapper: {
    position: 'relative',
    maxWidth: 200,
    maxHeight: 200,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  imageExpandIcon: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 12,
    padding: 4,
  },
  previewOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: {
    width: '100%',
    height: '100%',
    maxWidth: '100%',
    maxHeight: '100%',
  },
  msgAttachmentFile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    maxWidth: 200,
  },
  msgAttachmentFileName: {
    flexShrink: 1,
    fontSize: fontSize.xs,
    color: colors.textSecondary,
  },
  thinkingInline: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xs,
    backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  thinkingInlineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
  },
  thinkingInlineLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textMuted,
  },
  thinkingInlinePreview: {
    flex: 1,
    fontSize: 9,
    color: colors.textMuted,
    opacity: 0.7,
  },
  thinkingInlineBody: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 17,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 5,
  },
  queueBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  queueBarText: {
    flex: 1,
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  queueBarHint: {
    fontSize: fontSize.xs,
    color: colors.primary,
    fontWeight: '600',
    marginLeft: spacing.sm,
  },
  queueManagerSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bgRoot,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  queueManagerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  queueManagerCount: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  queueManagerEmpty: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
  queueManagerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  queueManagerName: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  queueManagerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(85,85,85,0.08)',
  },
  queueManagerBtnText: {
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  queueMenuPreview: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  backendStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  backendStatusBarOnline: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
  },
  backendStatusBarConnecting: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
  },
  backendStatusBarOffline: {
    backgroundColor: 'rgba(244,67,54,0.10)',
    borderColor: 'rgba(244,67,54,0.35)',
  },
  backendStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  backendStatusDotOnline: {
    backgroundColor: colors.success,
  },
  backendStatusDotConnecting: {
    backgroundColor: colors.warning,
  },
  backendStatusDotOffline: {
    backgroundColor: colors.error,
  },
  backendStatusText: {
    flex: 1,
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  networkBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.error,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    marginBottom: spacing.sm,
  },
  networkBannerText: {
    flex: 1,
    fontSize: fontSize.xs,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  messageStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  messageStatusPending: {
    fontSize: 10,
    color: colors.textMuted,
  },
  messageStatusError: {
    fontSize: 10,
    color: colors.error,
    fontWeight: '600',
  },
  messageTime: {
    fontSize: 9,
    color: colors.textMuted,
    marginTop: 3,
    paddingHorizontal: 4,
  },
  streamCursor: {
    color: colors.primary,
    fontWeight: '700',
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
  recordingOverlay: {
    position: 'absolute',
    top: -30,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.error,
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
  messageMenuContainer: {
    width: '86%',
    maxWidth: 320,
    alignSelf: 'center',
    borderRadius: 16,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    gap: 2,
    marginBottom: spacing.xl,
  },
  messageMenuTitle: {
    fontSize: fontSize.xs,
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  messageMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  messageMenuItemText: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  messageMenuItemCancel: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginTop: spacing.sm,
    justifyContent: 'center',
  },
  messageMenuItemCancelText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: '500',
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
  permissionTrustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: spacing.lg,
    paddingVertical: 2,
  },
  permissionCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionCheckboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  permissionTrustText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
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
    color: '#FFFFFF',
    fontWeight: '700',
  },
});
