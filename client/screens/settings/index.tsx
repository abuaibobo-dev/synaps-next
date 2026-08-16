import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Alert, Modal, Platform, Linking, TextInput, Image } from 'react-native';
import Animated, { SlideInRight, FadeOutLeft, FadeIn, Easing } from 'react-native-reanimated';
import { Screen } from '@/components/Screen';
import { MenuButton } from '@/components/Sidebar';
import { spacing, radius, fontSize, ACCENTS } from '@/utils/theme';
import type { ThemeColors, AccentKey } from '@/utils/theme';
import { useThemeColors } from '@/components/ThemeProvider';
import type { ThemeMode } from '@/components/ThemeProvider';
import { getApiBase } from '@/utils';
import { getCrashLogs, clearCrashLogs } from '@/utils/crashReporter';
import { getAppInfo, getDeviceStatus, setDeviceControlEnabled } from '@/utils/deviceControl';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import { AppIcon } from '@/components/AppIcon';
import {
  settingsColors,
  SettingsGroup,
  SettingRow,
  UnderlineInput,
  AnimatedToggle,
  SegmentControl,
  DANGER_COLOR,
  type SettingColors,
} from '@/components/SettingControls';

const API_BASE = getApiBase();

// 白灰主题：主强调（竖条/图标/分段激活/头像）
const ACCENT = '#3A3A3A';
// 交互态：聚焦边框 / 开关开启
const INTERACTIVE = '#555555';

interface SettingsScreenProps {
  onOpenSidebar: () => void;
}

interface Settings {
  ai_model: string;
  ai_api_key: string;
  ai_base_url: string;
  ai_model_base_url: string;
  stt_api_key: string;
  stt_base_url: string;
  stt_model: string;
  github_token: string;
  github_auto_push: string;
  termux_path: string;
  build_method: string;
  snapshot_enabled: string;
  diff_review_enabled: string;
  harness_enabled: string;
  harness_node_path: string;
  harness_dsh_path: string;
  harness_model: string;
  harness_api_key: string;
  harness_base_url: string;
  codex_enabled: string;
  codex_api_key: string;
  codex_bridge_url: string;
  codex_token: string;
  codex_model: string;
  codex_base_url: string;
  codex_wire_api: string;
  default_exec_brain: string;
  account_name: string;
  project_root: string;
  font_scale: string;
}

const DEFAULT_SETTINGS: Settings = {
  ai_model: 'deepseek-chat',
  ai_api_key: '',
  ai_base_url: '',
  ai_model_base_url: '',
  stt_api_key: '',
  stt_base_url: '',
  stt_model: 'whisper-1',
  github_token: '',
  github_auto_push: 'false',
  termux_path: '/data/data/com.termux',
  build_method: 'github_actions',
  snapshot_enabled: 'true',
  diff_review_enabled: 'true',
  harness_enabled: 'false',
  harness_node_path: '',
  harness_dsh_path: '',
  harness_model: 'deepseek-v4-flash',
  harness_api_key: '',
  harness_base_url: '',
  codex_enabled: 'false',
  codex_api_key: '',
  codex_bridge_url: 'http://127.0.0.1:19290',
  codex_token: '',
  codex_model: 'deepseek-v4-flash',
  codex_base_url: '',
  codex_wire_api: 'responses',
  default_exec_brain: 'auto',
  account_name: 'Synaps 用户',
  project_root: '/storage/emulated/0/Synaps',
  font_scale: 'medium',
};

interface BrainItem {
  id: string;
  agentType: string;
  name: string;
  cli: string;
  install: string;
  desc: string;
  installed: boolean;
  version: string | null;
  note: string;
}

interface BrainStatus {
  codex: { enabled: boolean; bridgeUrl: string; reachable: boolean; version: string | null; note: string };
  brains: BrainItem[];
  builtins: Array<{ id: string; name: string; desc: string }>;
  harness: { enabled: boolean; ready: boolean; note: string };
  defaultBrain: string;
}

interface McpServer {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
}

interface SkillItem {
  name: string;
  description: string;
  source: string;
  enabled: number;
}

type SectionKey = 'account' | 'ai' | 'dev' | 'appearance' | 'security' | 'skills' | 'storage' | 'about';
type ProviderKey = 'deepseek' | 'openai' | 'custom';
type FontKey = 'small' | 'medium' | 'large';

const MODE_OPTIONS: Array<{ key: ThemeMode; label: string }> = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
];


const PROVIDER_OPTIONS: Array<{ key: ProviderKey; label: string }> = [
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'openai', label: 'OpenAI' },
  { key: 'custom', label: '自定义' },
];

const FONT_OPTIONS: Array<{ key: FontKey; label: string }> = [
  { key: 'small', label: '小' },
  { key: 'medium', label: '标准' },
  { key: 'large', label: '大' },
];

const BUILD_OPTIONS: Array<{ key: 'github_actions' | 'local'; label: string }> = [
  { key: 'github_actions', label: 'GitHub Actions' },
  { key: 'local', label: '本地构建' },
];

const BRAIN_OPTIONS: Array<{ key: 'auto' | 'codex' | 'aider' | 'local'; label: string }> = [
  { key: 'auto', label: '自动' },
  { key: 'codex', label: 'Codex' },
  { key: 'aider', label: 'Aider' },
  { key: 'local', label: '本地' },
];

const CONTEXT_LIMITS: Record<string, string> = {
  'deepseek-chat': '128K',
  'deepseek-reasoner': '128K',
  'gpt-4o': '128K',
  'gpt-4o-mini': '128K',
  'gpt-4.1': '1M',
  'claude-3-5-sonnet': '200K',
  'claude-3-7-sonnet': '200K',
};

// 子页面字段清单（用于「保存全部」按钮）
const SECTION_KEYS: Record<SectionKey, Array<keyof Settings>> = {
  account: ['account_name', 'ai_api_key'],
  ai: [
    'ai_api_key',
    'ai_base_url',
    'ai_model',
    'ai_model_base_url',
    'stt_api_key',
    'stt_base_url',
    'stt_model',
    'harness_node_path',
    'harness_dsh_path',
    'harness_model',
    'harness_api_key',
    'harness_base_url',
  ],
  dev: ['project_root', 'termux_path', 'github_token'],
  appearance: [],
  security: [],
  skills: [],
  storage: [],
  about: [],
};

function renderDiagnostics(d: Record<string, any> | null): Array<{ ok: boolean; label: string; detail: string }> {
  if (!d) return [];
  const rows: Array<{ ok: boolean; label: string; detail: string }> = [];
  const backend = d.backend || {};
  rows.push({
    ok: backend.status === 'ok',
    label: '后端服务',
    detail: `状态 ${backend.status || '未知'} · 端口 ${backend.port ?? '-'} · 运行 ${backend.uptimeSec ?? 0}s · Node ${backend.nodeVersion || '-'}`,
  });
  const ai = d.ai || {};
  rows.push({
    ok: !!ai.apiKeyConfigured,
    label: 'AI 模型',
    detail: `${ai.model || '-'} · ${ai.apiKeyConfigured ? '已配置 Key' : '未配置 Key'}`,
  });
  const github = d.github || {};
  rows.push({
    ok: !!github.tokenConfigured,
    label: 'GitHub',
    detail: `${github.tokenConfigured ? '已配置 Token' : '未配置 Token'} · 自动推送 ${github.autoPush ? '开' : '关'}`,
  });
  const termux = d.termux || {};
  rows.push({
    ok: !!termux.exists,
    label: 'Termux',
    detail: `${termux.path || '-'} · ${termux.exists ? '存在' : '不存在'}`,
  });
  const device = d.device || {};
  rows.push({
    ok: !!device.enabled,
    label: '设备控制',
    detail: device.enabled ? '已启用' : '未启用（设置 → 开发环境 → 设备控制）',
  });
  const mcp = d.mcp || {};
  const mcpNames = Array.isArray(mcp.servers) ? (mcp.servers as string[]).join(', ') : '';
  rows.push({
    ok: true,
    label: 'MCP 服务器',
    detail: `${mcp.count ?? 0} 个${mcpNames ? `（${mcpNames}）` : ''}`,
  });
  const harness = d.harness || {};
  rows.push({
    ok: !!harness.enabled,
    label: 'DeepSeek Harness',
    detail: `${harness.enabled ? '已启用' : '未启用'} · Node ${harness.nodeVersion || '-'} · ${harness.nodeSatisfied ? '版本满足' : '版本过低'}`,
  });
  const db = d.db || {};
  const sizeKb = Math.round((db.fileSizeBytes ?? 0) / 1024);
  rows.push({
    ok: true,
    label: '数据库',
    detail: `${db.projects ?? 0} 项目 · ${db.agents ?? 0} Agent · ${db.skills ?? 0} 技能 · ${sizeKb} KB`,
  });
  return rows;
}

function FieldRow({
  label,
  sc,
  styles,
  last,
  children,
}: {
  label: string;
  sc: SettingColors;
  styles: ReturnType<typeof createStyles>;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View
      style={[
        styles.fieldRow,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: sc.separator },
      ]}
    >
      <Text style={[styles.fieldLabel, { color: sc.label }]}>{label}</Text>
      {children}
    </View>
  );
}

function SubPageHeader({
  title,
  onBack,
  bar,
  colors,
  styles,
  right,
}: {
  title: string;
  onBack: () => void;
  bar: string;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.subHeader}>
      <Pressable onPress={onBack} hitSlop={10} style={styles.backBtn}>
        <AppIcon name="chevron-left" size={22} color={bar} />
      </Pressable>
      <Text style={[styles.subHeaderTitle, { color: colors.textPrimary }]}>{title}</Text>
      {right}
    </View>
  );
}

export default function SettingsScreen({ onOpenSidebar }: SettingsScreenProps) {
  const { colors, isDark, mode, setMode, accent, setAccent } = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const sc = useMemo(() => settingsColors(colors, isDark), [colors, isDark]);
  const draftsRef = useRef<Record<string, string>>({});
  const [saveFeedback, setSaveFeedback] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [section, setSection] = useState<SectionKey | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [projects, setProjects] = useState<Array<{ id: string; name: string; path: string }>>([]);
  const [trustedProjects, setTrustedProjects] = useState<string[]>([]);
  const [auditLogs, setAuditLogs] = useState<Array<{ id: string; action: string; detail: string; risk_level: string; decision: string; created_at: string }>>([]);
  const [auditModalVisible, setAuditModalVisible] = useState(false);
  const [trustModalVisible, setTrustModalVisible] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [deviceEnabled, setDeviceEnabled] = useState(false);
  const [deviceServiceConnected, setDeviceServiceConnected] = useState(false);
  const [mcpModalVisible, setMcpModalVisible] = useState(false);
  const [mcpFormName, setMcpFormName] = useState('');
  const [mcpFormTransport, setMcpFormTransport] = useState<'stdio' | 'sse'>('stdio');
  const [mcpFormCommand, setMcpFormCommand] = useState('');
  const [mcpFormArgs, setMcpFormArgs] = useState('');
  const [mcpFormUrl, setMcpFormUrl] = useState('');
  const [backupModalVisible, setBackupModalVisible] = useState(false);
  const [backupJson, setBackupJson] = useState('');
  const [backupSummary, setBackupSummary] = useState('');
  const [latestRelease, setLatestRelease] = useState<string | null>(null);
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [importModalVisible, setImportModalVisible] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [diagnosticsVisible, setDiagnosticsVisible] = useState(false);
  const [diagnosticsData, setDiagnosticsData] = useState<Record<string, any> | null>(null);
  const [guideVisible, setGuideVisible] = useState(false);
  const [balance, setBalance] = useState<{ balance: number; available: boolean; message?: string } | null>(null);
  const [balanceRefreshing, setBalanceRefreshing] = useState(false);
  const [storageSize, setStorageSize] = useState('计算中...');

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/settings`);
      if (res.ok) {
        const data = await res.json();
        setSettings({ ...DEFAULT_SETTINGS, ...data });
      }
    } catch (error) {
      console.error('Failed to fetch settings:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    getAppInfo().then((info) => {
      if (info && info.versionName) setAppVersion(info.versionName);
    });
  }, []);

  const fetchPermissionData = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/projects`);
      const data = await res.json();
      setProjects(data.projects || []);
    } catch {
      // Ignore
    }
    try {
      const res = await fetch(`${API_BASE}/api/v1/settings`);
      const data = await res.json();
      try {
        const parsed = JSON.parse(data.trusted_projects || '[]');
        setTrustedProjects(Array.isArray(parsed) ? parsed : []);
      } catch {
        setTrustedProjects([]);
      }
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    fetchPermissionData();
  }, [fetchPermissionData]);

  const fetchMcpAndSkills = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/settings`);
      const data = await res.json();
      try {
        const parsed = JSON.parse(data.mcp_servers || '[]');
        setMcpServers(Array.isArray(parsed) ? parsed : []);
      } catch {
        setMcpServers([]);
      }
    } catch {
      // Ignore
    }
    try {
      const res = await fetch(`${API_BASE}/api/v1/skills`);
      const data = await res.json();
      setSkills(data.skills || []);
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    fetchMcpAndSkills();
  }, [fetchMcpAndSkills]);

  const fetchBalance = useCallback(async () => {
    setBalanceRefreshing(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/balance`);
      if (res.ok) {
        setBalance(await res.json());
      } else {
        setBalance({ balance: 0, available: false, message: `刷新失败（${res.status}），请检查后端服务` });
      }
    } catch {
      setBalance({ balance: 0, available: false, message: '刷新失败：后端服务未运行，请检查通知栏「本地后端服务运行中」' });
    } finally {
      setBalanceRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  const [brains, setBrains] = useState<BrainStatus | null>(null);
  const [brainsRefreshing, setBrainsRefreshing] = useState(false);
  const [brainsRefreshedAt, setBrainsRefreshedAt] = useState<number | null>(null);
  const fetchBrains = useCallback(async () => {
    if (brainsRefreshing) return;
    setBrainsRefreshing(true);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(`${API_BASE}/api/v1/brains/status`, { signal: ctrl.signal });
      if (res.ok) setBrains((await res.json()) as BrainStatus);
      setBrainsRefreshedAt(Date.now());
    } catch {
      // 后端或桥接不可达：保持上次状态，刷新时间照常更新
      setBrainsRefreshedAt(Date.now());
    } finally {
      clearTimeout(t);
      setBrainsRefreshing(false);
    }
  }, [brainsRefreshing]);

  useEffect(() => {
    fetchBrains();
  }, [fetchBrains]);

  // 自动检查最新版本（GitHub Releases）
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('https://api.github.com/repos/abuaibobo-dev/synaps-next/releases/latest');
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data.tag_name === 'string') setLatestRelease(data.tag_name);
      } catch {
        // 离线时静默
      }
    })();
  }, []);

  const isUpdateAvailable = useMemo(() => {
    if (!latestRelease) return false;
    const cur = appVersion.replace(/^v/i, '');
    const latest = latestRelease.replace(/^v/i, '');
    const curParts = cur.split('.').map(Number);
    const latestParts = latest.split('.').map(Number);
    for (let i = 0; i < Math.max(curParts.length, latestParts.length); i += 1) {
      const a = curParts[i] || 0;
      const b = latestParts[i] || 0;
      if (b > a) return true;
      if (b < a) return false;
    }
    return false;
  }, [latestRelease, appVersion]);

  const calcStorage = useCallback(async () => {
    setStorageSize('计算中...');
    try {
      const dir = FileSystem.documentDirectory;
      if (!dir) {
        setStorageSize('未知');
        return;
      }
      let bytes = 0;
      const entries = await FileSystem.readDirectoryAsync(dir);
      for (const name of entries) {
        const f = await FileSystem.getInfoAsync(dir + name);
        if (f.exists && 'size' in f) bytes += Number(f.size || 0);
      }
      if (bytes > 1024 * 1024) setStorageSize(`${(bytes / 1024 / 1024).toFixed(1)} MB`);
      else if (bytes > 1024) setStorageSize(`${(bytes / 1024).toFixed(0)} KB`);
      else setStorageSize(`${bytes} B`);
    } catch {
      setStorageSize('未知');
    }
  }, []);

  const updateSetting = useCallback(async (key: keyof Settings, value: string): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      if (res.ok) {
        setSettings((prev) => ({ ...prev, [key]: value }));
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to update setting:', error);
      Alert.alert('错误', '保存设置失败');
      return false;
    }
  }, []);

  const showFeedback = useCallback((fb: { type: 'success' | 'error' | 'info'; text: string }) => {
    setSaveFeedback(fb);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setSaveFeedback(null), 2600);
  }, []);

  const verifyApi = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/balance`);
      const data = await res.json();
      if (data.available) return { ok: true, message: '验证通过' };
      return { ok: false, message: data.message || '验证失败' };
    } catch {
      return { ok: false, message: '无法连接后端' };
    }
  }, []);

  const saveSetting = useCallback(
    async (key: keyof Settings, value: string) => {
      const ok = await updateSetting(key, value);
      if (!ok) return;
      const aiKeys = ['ai_api_key', 'ai_base_url', 'ai_model', 'ai_model_base_url'];
      if (aiKeys.includes(key)) {
        showFeedback({ type: 'info', text: '已保存 · 验证中...' });
        const v = await verifyApi();
        showFeedback({
          type: v.ok ? 'success' : 'error',
          text: v.ok ? '已保存 · 验证通过' : `已保存 · 验证失败：${v.message}`,
        });
      } else {
        showFeedback({ type: 'success', text: '已保存' });
      }
    },
    [updateSetting, showFeedback, verifyApi]
  );

  // 输入草稿：保存按钮兜底，未失焦也能保存
  const trackDraft = useCallback(
    (key: keyof Settings) => (text: string) => {
      draftsRef.current[key] = text;
    },
    []
  );

  const saveAll = useCallback(
    async (keys: Array<keyof Settings>) => {
      let saved = 0;
      for (const key of keys) {
        const draft = draftsRef.current[key];
        if (draft !== undefined) {
          const ok = await updateSetting(key, draft);
          if (ok) {
            saved += 1;
            delete draftsRef.current[key];
          }
        }
      }
      if (saved > 0) showFeedback({ type: 'success', text: `已保存 ${saved} 项设置` });
    },
    [updateSetting, showFeedback]
  );

  const handleToggle = useCallback(
    (key: keyof Settings) => {
      const currentValue = settings[key] === 'true';
      updateSetting(key, (!currentValue).toString());
    },
    [settings, updateSetting]
  );

  const handleShowCrashLogs = useCallback(async () => {
    const logs = await getCrashLogs();
    if (logs.length === 0) {
      Alert.alert('崩溃日志', '暂无崩溃日志');
      return;
    }
    Alert.alert('崩溃日志', logs.join('\n\n---\n\n'), [
      { text: '清空', style: 'destructive', onPress: () => clearCrashLogs() },
      { text: '关闭', style: 'cancel' },
    ]);
  }, []);

  const exportBackup = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/backup/export`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const json = JSON.stringify(data, null, 2);
      setBackupJson(json);
      const counts = Object.entries(data.tables || {})
        .map(([k, v]) => `${k}:${Array.isArray(v) ? v.length : 0}`)
        .join('  ');
      setBackupSummary(`共导出 ${counts}`);
      setBackupModalVisible(true);
      try {
        if (FileSystem.documentDirectory) {
          const uri = FileSystem.documentDirectory + `synaps-backup-${new Date().toISOString().slice(0, 10)}.json`;
          await FileSystem.writeAsStringAsync(uri, json);
        }
      } catch {
        // 保存文件失败不影响复制
      }
    } catch (err) {
      Alert.alert('导出失败', String(err));
    }
  }, []);

  const copyBackup = useCallback(async () => {
    await Clipboard.setStringAsync(backupJson);
    Alert.alert('已复制', '备份 JSON 已复制到剪贴板，可在另一台设备上「导入备份」');
  }, [backupJson]);

  const exportLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/backup/logs`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const json = JSON.stringify(data, null, 2);
      setBackupJson(json);
      setBackupSummary(`审计日志 ${data.auditLogs?.length ?? 0} 条 · 命令历史 ${data.commandHistory?.length ?? 0} 条`);
      setBackupModalVisible(true);
      try {
        if (FileSystem.documentDirectory) {
          const uri = FileSystem.documentDirectory + `synaps-logs-${new Date().toISOString().slice(0, 10)}.json`;
          await FileSystem.writeAsStringAsync(uri, json);
        }
      } catch {
        // 保存文件失败不影响复制
      }
    } catch (err) {
      Alert.alert('导出失败', String(err));
    }
  }, []);

  const importBackup = useCallback(async () => {
    if (!importText.trim()) {
      Alert.alert('提示', '请粘贴备份 JSON 内容');
      return;
    }
    setImporting(true);
    try {
      const parsed = JSON.parse(importText);
      const payload = parsed.tables ? parsed : { data: parsed };
      const res = await fetch(`${API_BASE}/api/v1/backup/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'HTTP ' + res.status);
      const counts = Object.entries(result.counts || {})
        .map(([k, v]) => `${k}:${v}`)
        .join('  ');
      setImportModalVisible(false);
      setImportText('');
      Alert.alert('导入成功', `已恢复数据：${counts}`);
    } catch (err) {
      Alert.alert('导入失败', String(err));
    } finally {
      setImporting(false);
    }
  }, [importText]);

  const runDiagnostics = useCallback(async () => {
    setDiagnosticsData(null);
    setDiagnosticsVisible(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/diagnostics`);
      const data = await res.json();
      setDiagnosticsData(data);
    } catch (err) {
      setDiagnosticsData({ error: String(err) });
    }
  }, []);

  const toggleTrust = useCallback(
    async (projectId: string) => {
      const next = trustedProjects.includes(projectId)
        ? trustedProjects.filter((id) => id !== projectId)
        : [...trustedProjects, projectId];
      setTrustedProjects(next);
      try {
        await fetch(`${API_BASE}/api/v1/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trusted_projects: JSON.stringify(next) }),
        });
      } catch {
        Alert.alert('错误', '保存失败');
      }
    },
    [trustedProjects]
  );

  const fetchAuditLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/audit?limit=50`);
      const data = await res.json();
      setAuditLogs(data.logs || []);
      setAuditModalVisible(true);
    } catch {
      Alert.alert('错误', '加载审计日志失败');
    }
  }, []);

  const resetPermissions = useCallback(() => {
    Alert.alert('重置授权', '将清除所有项目的可信标记。确定继续？', [
      { text: '取消', style: 'cancel' },
      {
        text: '重置',
        style: 'destructive',
        onPress: async () => {
          try {
            await fetch(`${API_BASE}/api/v1/settings`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ trusted_projects: '[]' }),
            });
            setTrustedProjects([]);
            Alert.alert('完成', '已重置所有授权');
          } catch {
            Alert.alert('错误', '重置失败');
          }
        },
      },
    ]);
  }, []);

  const clearAllData = useCallback(() => {
    Alert.alert('清除所有数据', '将清除所有设置、可信授权、MCP 配置与本地缓存，且无法恢复。确定继续？', [
      { text: '取消', style: 'cancel' },
      {
        text: '继续',
        style: 'destructive',
        onPress: () => {
          Alert.alert('再次确认', '此操作不可撤销，将重置所有数据。', [
            { text: '取消', style: 'cancel' },
            {
              text: '确认清除',
              style: 'destructive',
              onPress: async () => {
                try {
                  await fetch(`${API_BASE}/api/v1/settings`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      ...DEFAULT_SETTINGS,
                      trusted_projects: '[]',
                      mcp_servers: '[]',
                    }),
                  });
                  setSettings({ ...DEFAULT_SETTINGS });
                  setTrustedProjects([]);
                  setMcpServers([]);
                  setBalance(null);
                  Alert.alert('完成', '所有数据已清除');
                } catch {
                  Alert.alert('错误', '清除失败');
                }
              },
            },
          ]);
        },
      },
    ]);
  }, []);

  const riskLabel = useCallback(
    (level: string) =>
      ({ none: '无风险', medium: '中风险', high: '高风险', critical: '极高风险' }[level] || level),
    []
  );
  const decisionLabel = useCallback(
    (decision: string) =>
      ({ auto: '自动放行', trusted: '可信项目', approved: '用户允许', denied: '用户拒绝', blocked: '策略拦截' }[decision] || decision),
    []
  );

  const openMcpModal = useCallback(() => {
    setMcpFormName('');
    setMcpFormTransport('stdio');
    setMcpFormCommand('');
    setMcpFormArgs('');
    setMcpFormUrl('');
    setMcpModalVisible(true);
  }, []);

  const saveMcpServer = useCallback(async () => {
    if (!mcpFormName.trim()) {
      Alert.alert('提示', '请输入服务器名称');
      return;
    }
    const server: McpServer = { name: mcpFormName.trim(), transport: mcpFormTransport };
    if (server.transport === 'stdio') {
      if (!mcpFormCommand.trim()) {
        Alert.alert('提示', 'stdio 需要填写启动命令');
        return;
      }
      server.command = mcpFormCommand.trim();
      server.args = mcpFormArgs.split(',').map((x) => x.trim()).filter(Boolean);
    } else {
      if (!mcpFormUrl.trim()) {
        Alert.alert('提示', 'sse 需要填写 URL');
        return;
      }
      server.url = mcpFormUrl.trim();
    }
    const next = [...mcpServers.filter((x) => x.name !== server.name), server];
    setMcpServers(next);
    setMcpModalVisible(false);
    try {
      await fetch(`${API_BASE}/api/v1/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcp_servers: JSON.stringify(next) }),
      });
    } catch {
      Alert.alert('错误', '保存失败');
    }
  }, [mcpFormName, mcpFormTransport, mcpFormCommand, mcpFormArgs, mcpFormUrl, mcpServers]);

  const removeMcpServer = useCallback(
    (name: string) => {
      Alert.alert('删除 MCP 服务器', `确定删除 "${name}"？`, [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            const next = mcpServers.filter((x) => x.name !== name);
            setMcpServers(next);
            try {
              await fetch(`${API_BASE}/api/v1/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mcp_servers: JSON.stringify(next) }),
              });
            } catch {
              Alert.alert('错误', '保存失败');
            }
          },
        },
      ]);
    },
    [mcpServers]
  );

  const toggleSkill = useCallback(async (name: string, enabled: boolean) => {
    setSkills((prev) => prev.map((x) => (x.name === name ? { ...x, enabled: enabled ? 1 : 0 } : x)));
    try {
      await fetch(`${API_BASE}/api/v1/skills/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch {
      Alert.alert('错误', '保存失败');
    }
  }, []);

  const showSkillDetail = useCallback(async (name: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/skills/${encodeURIComponent(name)}`);
      const data = await res.json();
      Alert.alert(
        data.name,
        `${data.description || '无描述'}\n\n${(data.content || '').slice(0, 2000)}`,
        [{ text: '关闭', style: 'cancel' }]
      );
    } catch {
      Alert.alert('错误', '加载技能失败');
    }
  }, []);

  const handleClearCache = useCallback(() => {
    Alert.alert('清除缓存', '确定要清除所有缓存数据吗？', [
      { text: '取消', style: 'cancel' },
      { text: '确定', style: 'destructive', onPress: () => Alert.alert('完成', '缓存已清除') },
    ]);
  }, []);

  const refreshDeviceStatus = useCallback(async () => {
    const st = await getDeviceStatus();
    setDeviceEnabled(st.enabled);
    setDeviceServiceConnected(st.serviceConnected);
  }, []);

  useEffect(() => {
    refreshDeviceStatus();
    const timer = setInterval(refreshDeviceStatus, 4000);
    return () => clearInterval(timer);
  }, [refreshDeviceStatus]);

  const toggleDeviceControl = useCallback(
    async (value: boolean) => {
      const ok = await setDeviceControlEnabled(value);
      setDeviceEnabled(ok ? value : !value);
      refreshDeviceStatus();
    },
    [refreshDeviceStatus]
  );

  const openAccessibilitySettings = useCallback(() => {
    if (Platform.OS === 'android') {
      Linking.openURL('intent:#Intent;action=android.settings.ACCESSIBILITY_SETTINGS;end').catch(() => {
        Alert.alert('提示', '请在系统设置 → 无障碍 中开启 Synaps 设备控制');
      });
    } else {
      Alert.alert('提示', '设备控制仅支持 Android');
    }
  }, []);

  const maskValue = useCallback((value: string) => {
    if (!value) return '未配置';
    if (value.length <= 8) return '***';
    return value.slice(0, 4) + '...' + value.slice(-4);
  }, []);

  const provider = useMemo<ProviderKey>(() => {
    if (settings.ai_base_url.includes('openai')) return 'openai';
    if (settings.ai_base_url.includes('deepseek')) return 'deepseek';
    return 'custom';
  }, [settings.ai_base_url]);

  const setProvider = useCallback(
    (key: ProviderKey) => {
      if (key === 'deepseek') saveSetting('ai_base_url', 'https://api.deepseek.com');
      else if (key === 'openai') saveSetting('ai_base_url', 'https://api.openai.com/v1');
    },
    [saveSetting]
  );

  const contextLimit = useMemo(() => CONTEXT_LIMITS[settings.ai_model] || '32K', [settings.ai_model]);

  const balanceText = useMemo(() => {
    if (!balance) return '查询中...';
    if (balance.balance === -1) return '额度未知';
    if (!balance.available) return balance.message || '未配置';
    const v = Math.round(Number(balance.balance) * 100) / 100;
    const fmt = !Number.isFinite(v) ? '0.00' : v >= 100000000 ? `${(v / 100000000).toFixed(2)}亿` : v >= 10000 ? `${(v / 10000).toFixed(2)}万` : v.toFixed(2);
    return `¥${fmt}`;
  }, [balance]);

  const checkUpdate = useCallback(() => {
    const url = latestRelease
      ? `https://github.com/abuaibobo-dev/synaps-next/releases/tag/${latestRelease}`
      : 'https://github.com/abuaibobo-dev/synaps-next/releases';
    Linking.openURL(url).catch(() => {
      Alert.alert('提示', '无法打开浏览器，请访问 GitHub Releases 页面');
    });
  }, [latestRelease]);

  const exportCrashLogs = useCallback(async () => {
    const logs = await getCrashLogs();
    try {
      const uri =
        FileSystem.documentDirectory + `synaps-crash-${new Date().toISOString().slice(0, 10)}.txt`;
      const body = logs.length > 0 ? logs.join('\n\n---\n\n') : '暂无崩溃日志';
      await FileSystem.writeAsStringAsync(uri, body);
      Alert.alert('导出完成', `崩溃日志已保存到：\n${uri}\n\n可复制后分享给开发者排查。`, [
        {
          text: '复制',
          onPress: () => {
            Clipboard.setStringAsync(body);
          },
        },
        { text: '关闭', style: 'cancel' },
      ]);
    } catch {
      Alert.alert('错误', '导出失败');
    }
  }, []);

  const codexBrainText = useMemo(() => {
    if (!brains) return '检测中...';
    if (!brains.codex.enabled) return '未启用';
    if (brains.codex.reachable) return `✅ 已连接 ${brains.codex.version || ''}`.trim();
    return '⚠️ 未连接';
  }, [brains]);
  const copyBridgeCommand = useCallback(async () => {
    let cmd = `curl -o ~/codex-bridge.js ${API_BASE}/api/v1/bridge/script && node ~/codex-bridge.js &`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${API_BASE}/api/v1/bridge/command`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.command === 'string') cmd = data.command;
      }
    } catch {
      // 后端未就绪时使用本地拼接的默认命令
    }
    await Clipboard.setStringAsync(cmd);
    Alert.alert('已复制', '在 Termux 里粘贴运行这一条即可。\n（需先安装 Node：pkg install nodejs -y）');
  }, []);

  const mainPage = (
    <>
      <SettingsGroup title="账户与安全" sc={sc} bar={ACCENT}>
        <SettingRow label="账户与安全" icon="user" iconColor={ACCENT} sc={sc} onPress={() => setSection('account')} last />
      </SettingsGroup>
      <SettingsGroup title="AI 模型" sc={sc} bar={ACCENT}>
        <SettingRow label="AI 模型" icon="bot" iconColor={ACCENT} sc={sc} onPress={() => setSection('ai')} last />
      </SettingsGroup>
      <SettingsGroup title="开发环境" sc={sc} bar={ACCENT}>
        <SettingRow label="开发环境" icon="terminal" iconColor={ACCENT} sc={sc} onPress={() => setSection('dev')} last />
      </SettingsGroup>
      <SettingsGroup title="外观" sc={sc} bar={ACCENT}>
        <SettingRow label="外观" icon="palette" iconColor={ACCENT} sc={sc} onPress={() => setSection('appearance')} last />
      </SettingsGroup>
      <SettingsGroup title="安全" sc={sc} bar={ACCENT}>
        <SettingRow label="安全" icon="shield" iconColor={ACCENT} sc={sc} onPress={() => setSection('security')} last />
      </SettingsGroup>
      <SettingsGroup title="技能与 MCP" sc={sc} bar={ACCENT}>
        <SettingRow label="技能与 MCP" icon="plug" iconColor={ACCENT} sc={sc} onPress={() => setSection('skills')} last />
      </SettingsGroup>
      <SettingsGroup title="存储与日志" sc={sc} bar={ACCENT}>
        <SettingRow
          label="存储与日志"
          icon="database"
          iconColor={ACCENT}
          sc={sc}
          onPress={() => {
            setSection('storage');
            calcStorage();
          }}
          last
        />
      </SettingsGroup>
      <SettingsGroup title="关于" sc={sc} bar={ACCENT}>
        <SettingRow label="关于" icon="info" iconColor={ACCENT} sc={sc} onPress={() => setSection('about')} last />
      </SettingsGroup>
      <Pressable
        style={[styles.clearCard, { backgroundColor: sc.cardBg, borderColor: sc.cardBorder }]}
        onPress={clearAllData}
      >
        <AppIcon name="trash-2" size={18} color={DANGER_COLOR} />
        <Text style={[styles.clearText, { color: DANGER_COLOR }]}>清除所有数据</Text>
      </Pressable>
    </>
  );

  const accountPage = (
    <>
      <SettingsGroup title="账户" sc={sc} bar={ACCENT}>
        <View style={styles.avatarRow}>
          <Image source={require('@/assets/images/avatar.png')} style={styles.avatar} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.fieldLabel, { color: sc.label }]}>账户名</Text>
            <UnderlineInput
              value={settings.account_name}
              placeholder="Synaps 用户"
              sc={sc}
              focusColor={INTERACTIVE}
              onChangeText={trackDraft('account_name')}
              onCommit={(v) => saveSetting('account_name', v)}
            />
          </View>
        </View>
      </SettingsGroup>
      <SettingsGroup title="API Key" sc={sc} bar={ACCENT}>
        <FieldRow styles={styles} label="DeepSeek API Key" sc={sc}>
          <UnderlineInput
            value={settings.ai_api_key}
            placeholder="sk-..."
            secure
            sc={sc}
            focusColor={INTERACTIVE}
            onChangeText={trackDraft('ai_api_key')}
            onCommit={(v) => saveSetting('ai_api_key', v)}
          />
        </FieldRow>
      </SettingsGroup>
      <SettingsGroup title="余额" sc={sc} bar={ACCENT}>
        <SettingRow
          label="当前余额"
          value={balanceText}
          icon="key"
          iconColor={ACCENT}
          sc={sc}
          right={
            <Pressable onPress={fetchBalance} hitSlop={8} disabled={balanceRefreshing} style={styles.refreshBtn}>
              <AppIcon
                name="refresh-cw"
                size={16}
                color={sc.arrow}
                style={balanceRefreshing ? { opacity: 0.5 } : undefined}
              />
            </Pressable>
          }
          last
        />
      </SettingsGroup>
    </>
  );

  const aiPage = (
    <>
      <SettingsGroup title="AI 模型" sc={sc} bar={ACCENT}>
        <View style={[styles.segmentBlock, { borderBottomColor: sc.separator }]}>
          <Text style={[styles.fieldLabel, { color: sc.label }]}>提供商</Text>
          <SegmentControl options={PROVIDER_OPTIONS} value={provider} onChange={setProvider} activeColor={ACCENT} inactiveBg={sc.underline} textColor={sc.value} />
        </View>
        <FieldRow styles={styles} label="API Key" sc={sc}>
          <UnderlineInput
            value={settings.ai_api_key}
            placeholder="sk-..."
            secure
            sc={sc}
            focusColor={INTERACTIVE}
            onChangeText={trackDraft('ai_api_key')}
            onCommit={(v) => saveSetting('ai_api_key', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="服务地址" sc={sc}>
          <UnderlineInput
            value={settings.ai_base_url}
            placeholder="https://api.deepseek.com"
            sc={sc}
            focusColor={INTERACTIVE}
            keyboardType="url"
            autoCapitalize="none"
            onChangeText={trackDraft('ai_base_url')}
            onCommit={(v) => saveSetting('ai_base_url', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="模型" sc={sc}>
          <UnderlineInput
            value={settings.ai_model}
            placeholder="deepseek-chat"
            sc={sc}
            focusColor={INTERACTIVE}
            autoCapitalize="none"
            onChangeText={trackDraft('ai_model')}
            onCommit={(v) => saveSetting('ai_model', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="模型 API 地址" sc={sc}>
          <UnderlineInput
            value={settings.ai_model_base_url}
            placeholder="DeepSeek 官方"
            sc={sc}
            focusColor={INTERACTIVE}
            keyboardType="url"
            autoCapitalize="none"
            onChangeText={trackDraft('ai_model_base_url')}
            onCommit={(v) => saveSetting('ai_model_base_url', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="上下文限制" sc={sc} last>
          <Text style={[styles.fieldValue, { color: sc.value }]}>{contextLimit}</Text>
        </FieldRow>
      </SettingsGroup>
      <SettingsGroup title="DeepSeek Harness" sc={sc} bar={ACCENT}>
        <SettingRow
          label="启用 Harness"
          icon="bot"
          iconColor={ACCENT}
          sc={sc}
          right={<AnimatedToggle value={settings.harness_enabled === 'true'} onValueChange={() => handleToggle('harness_enabled')} sc={sc} trackOn={INTERACTIVE} />}
        />
        <FieldRow styles={styles} label="Node 22+ 路径" sc={sc}>
          <UnderlineInput
            value={settings.harness_node_path}
            placeholder="使用内置 Node"
            sc={sc}
            focusColor={INTERACTIVE}
            autoCapitalize="none"
            onChangeText={trackDraft('harness_node_path')}
            onCommit={(v) => saveSetting('harness_node_path', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="dsh 入口路径" sc={sc}>
          <UnderlineInput
            value={settings.harness_dsh_path}
            placeholder="自动 npx 安装"
            sc={sc}
            focusColor={INTERACTIVE}
            autoCapitalize="none"
            onChangeText={trackDraft('harness_dsh_path')}
            onCommit={(v) => saveSetting('harness_dsh_path', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="模型" sc={sc}>
          <UnderlineInput
            value={settings.harness_model}
            placeholder="deepseek-v4-flash"
            sc={sc}
            focusColor={INTERACTIVE}
            autoCapitalize="none"
            onChangeText={trackDraft('harness_model')}
            onCommit={(v) => saveSetting('harness_model', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="API Key" sc={sc}>
          <UnderlineInput
            value={settings.harness_api_key}
            placeholder="使用 AI 模型 Key"
            secure
            sc={sc}
            focusColor={INTERACTIVE}
            onChangeText={trackDraft('harness_api_key')}
            onCommit={(v) => saveSetting('harness_api_key', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="API 地址" sc={sc} last>
          <UnderlineInput
            value={settings.harness_base_url}
            placeholder="DeepSeek 官方"
            sc={sc}
            focusColor={INTERACTIVE}
            keyboardType="url"
            autoCapitalize="none"
            onChangeText={trackDraft('harness_base_url')}
            onCommit={(v) => saveSetting('harness_base_url', v)}
          />
        </FieldRow>
      </SettingsGroup>

      <SettingsGroup title="执行大脑" sc={sc} bar={ACCENT}>
        <SettingRow
          label="Codex CLI 桥接"
          value={brainsRefreshing ? '刷新中...' : brainsRefreshedAt ? `已刷新 ${new Date(brainsRefreshedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : codexBrainText}
          icon="terminal"
          iconColor={ACCENT}
          sc={sc}
          right={
            <Pressable onPress={fetchBrains} hitSlop={8} disabled={brainsRefreshing} style={styles.refreshBtn}>
              <AppIcon
                name="refresh-cw"
                size={16}
                color={sc.arrow}
                style={brainsRefreshing ? { opacity: 0.5 } : undefined}
              />
            </Pressable>
          }
        />
        {(brains?.brains || []).map((b, i) => (
          <SettingRow
            key={b.id}
            label={b.name}
            value={b.installed ? `✅ ${b.version || '已安装'}` : '⚠️ 未安装'}
            icon={b.id === 'aider' ? 'code' : b.id === 'sage' ? 'test-tube' : 'bot'}
            iconColor={ACCENT}
            sc={sc}
            last={i === (brains?.brains || []).length - 1}
          />
        ))}
        <SettingRow
          label="内置能力"
          value={brains ? '✅ 搜索 / 设备控制 / 主模型' : '检测中...'}
          icon="smartphone"
          iconColor={ACCENT}
          sc={sc}
        />
        <View style={[styles.segmentBlock, { borderBottomColor: sc.separator }]}>
          <Text style={[styles.fieldLabel, { color: sc.label }]}>默认执行大脑</Text>
          <SegmentControl
            options={BRAIN_OPTIONS}
            value={settings.default_exec_brain || 'auto'}
            onChange={(k) => saveSetting('default_exec_brain', k)}
            activeColor={ACCENT}
            inactiveBg={sc.underline}
            textColor={sc.value}
          />
        </View>
      </SettingsGroup>
      <SettingsGroup title="Codex CLI" sc={sc} bar={ACCENT}>
        <SettingRow
          label="启用 Codex CLI"
          icon="terminal"
          iconColor={ACCENT}
          sc={sc}
          right={<AnimatedToggle value={settings.codex_enabled === 'true'} onValueChange={() => handleToggle('codex_enabled')} sc={sc} trackOn={INTERACTIVE} />}
        />
        <SettingRow
          label="复制一键安装命令"
          icon="download"
          iconColor={ACCENT}
          sc={sc}
          onPress={copyBridgeCommand}
          right={<Text style={[styles.fieldValue, { color: sc.value }]}>复制</Text>}
        />
        <FieldRow styles={styles} label="桥接服务地址" sc={sc}>
          <UnderlineInput
            value={settings.codex_bridge_url}
            placeholder="http://127.0.0.1:19290"
            sc={sc}
            focusColor={INTERACTIVE}
            keyboardType="url"
            autoCapitalize="none"
            onChangeText={trackDraft('codex_bridge_url')}
            onCommit={(v) => saveSetting('codex_bridge_url', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="访问令牌（可选）" sc={sc}>
          <UnderlineInput
            value={settings.codex_token}
            placeholder="Termux 桥接脚本里设置的 x-codex-token"
            secure
            sc={sc}
            focusColor={INTERACTIVE}
            autoCapitalize="none"
            onChangeText={trackDraft('codex_token')}
            onCommit={(v) => saveSetting('codex_token', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="API Key（可选）" sc={sc}>
          <UnderlineInput
            value={settings.codex_api_key}
            placeholder="留空使用 AI 模型 Key"
            secure
            sc={sc}
            focusColor={INTERACTIVE}
            autoCapitalize="none"
            onChangeText={trackDraft('codex_api_key')}
            onCommit={(v) => saveSetting('codex_api_key', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="模型" sc={sc}>
          <UnderlineInput
            value={settings.codex_model}
            placeholder="deepseek-v4-flash"
            sc={sc}
            focusColor={INTERACTIVE}
            autoCapitalize="none"
            onChangeText={trackDraft('codex_model')}
            onCommit={(v) => saveSetting('codex_model', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="API 地址" sc={sc}>
          <UnderlineInput
            value={settings.codex_base_url}
            placeholder="https://api.deepseek.com（留空用 AI 模型的地址）"
            sc={sc}
            focusColor={INTERACTIVE}
            keyboardType="url"
            autoCapitalize="none"
            onChangeText={trackDraft('codex_base_url')}
            onCommit={(v) => saveSetting('codex_base_url', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="接口协议" sc={sc}>
          <UnderlineInput
            value={settings.codex_wire_api}
            placeholder="responses"
            sc={sc}
            focusColor={INTERACTIVE}
            autoCapitalize="none"
            onChangeText={trackDraft('codex_wire_api')}
            onCommit={(v) => saveSetting('codex_wire_api', v)}
          />
        </FieldRow>
        <SettingRow
          label="Termux 安装说明"
          icon="info"
          iconColor={ACCENT}
          sc={sc}
          onPress={() => Linking.openURL('https://github.com/abuaibobo-dev/synaps-next/blob/master/docs/CODEX_SETUP.md').catch(() => {})}
          right={<Text style={[styles.fieldValue, { color: sc.value }]}>查看</Text>}
          last
        />
      </SettingsGroup>
    </>
  );

  const devPage = (
    <>
      <SettingsGroup title="项目与终端" sc={sc} bar={ACCENT}>
        <FieldRow styles={styles} label="项目目录" sc={sc}>
          <UnderlineInput
            value={settings.project_root}
            placeholder="/storage/emulated/0/Synaps"
            sc={sc}
            focusColor={INTERACTIVE}
            autoCapitalize="none"
            onChangeText={trackDraft('project_root')}
            onCommit={(v) => saveSetting('project_root', v)}
          />
        </FieldRow>
        <FieldRow styles={styles} label="Termux 路径" sc={sc} last>
          <UnderlineInput
            value={settings.termux_path}
            placeholder="/data/data/com.termux"
            sc={sc}
            focusColor={INTERACTIVE}
            autoCapitalize="none"
            onChangeText={trackDraft('termux_path')}
            onCommit={(v) => saveSetting('termux_path', v)}
          />
        </FieldRow>
      </SettingsGroup>
      <SettingsGroup title="GitHub" sc={sc} bar={ACCENT}>
        <FieldRow styles={styles} label="Access Token" sc={sc}>
          <UnderlineInput
            value={settings.github_token}
            placeholder="ghp_..."
            secure
            sc={sc}
            focusColor={INTERACTIVE}
            onChangeText={trackDraft('github_token')}
            onCommit={(v) => saveSetting('github_token', v)}
          />
        </FieldRow>
        <SettingRow
          label="自动推送"
          icon="github"
          iconColor={ACCENT}
          sc={sc}
          right={<AnimatedToggle value={settings.github_auto_push === 'true'} onValueChange={() => handleToggle('github_auto_push')} sc={sc} trackOn={INTERACTIVE} />}
          last
        />
      </SettingsGroup>
      <SettingsGroup title="构建" sc={sc} bar={ACCENT}>
        <View style={[styles.segmentBlock, { borderBottomColor: sc.separator }]}>
          <Text style={[styles.fieldLabel, { color: sc.label }]}>构建方式</Text>
          <SegmentControl
            options={BUILD_OPTIONS}
            value={settings.build_method === 'local' ? 'local' : 'github_actions'}
            onChange={(k) => saveSetting('build_method', k)}
            activeColor={ACCENT}
            inactiveBg={sc.underline}
            textColor={sc.value}
          />
        </View>
      </SettingsGroup>
      <SettingsGroup title="设备控制" sc={sc} bar={ACCENT}>
        <SettingRow
          label="启用设备控制"
          value={deviceServiceConnected ? '服务已连接' : '服务未连接'}
          icon="smartphone"
          iconColor={ACCENT}
          sc={sc}
          right={<AnimatedToggle value={deviceEnabled} onValueChange={toggleDeviceControl} sc={sc} trackOn={INTERACTIVE} />}
        />
        <SettingRow
          label="打开无障碍设置"
          value={deviceServiceConnected ? '已开启' : '去开启'}
          icon="lock"
          iconColor={ACCENT}
          sc={sc}
          onPress={openAccessibilitySettings}
          last
        />
      </SettingsGroup>
    </>
  );

  const appearancePage = (
    <>
      <SettingsGroup title="主题" sc={sc} bar={ACCENT}>
        <View style={[styles.segmentBlock, { borderBottomColor: sc.separator }]}>
          <Text style={[styles.fieldLabel, { color: sc.label }]}>主题模式</Text>
          <SegmentControl options={MODE_OPTIONS} value={mode} onChange={setMode} activeColor={ACCENT} inactiveBg={sc.underline} textColor={sc.value} />
        </View>
      </SettingsGroup>
      <SettingsGroup title="强调色" sc={sc} bar={ACCENT}>
        <View style={styles.accentRow}>
          {(Object.keys(ACCENTS) as AccentKey[]).map((key) => (
            <Pressable key={key} style={styles.accentItem} onPress={() => setAccent(key)} accessibilityLabel={`强调色 ${ACCENTS[key].label}`}>
              <View
                style={[
                  styles.accentSwatch,
                  { backgroundColor: ACCENTS[key].swatch },
                  accent === key && styles.accentSwatchActive,
                ]}
              >
                {accent === key && <AppIcon name="check-circle" size={13} color="#FFFFFF" />}
              </View>
              <Text style={[styles.accentLabel, { color: accent === key ? ACCENT : sc.value }]}>{ACCENTS[key].label}</Text>
            </Pressable>
          ))}
        </View>
      </SettingsGroup>
      <SettingsGroup title="字体大小" sc={sc} bar={ACCENT}>
        <View style={[styles.segmentBlock, { borderBottomColor: sc.separator }]}>
          <Text style={[styles.fieldLabel, { color: sc.label }]}>字体大小</Text>
          <SegmentControl
            options={FONT_OPTIONS}
            value={(settings.font_scale || 'medium') as FontKey}
            onChange={(k) => saveSetting('font_scale', k)}
            activeColor={ACCENT}
            inactiveBg={sc.underline}
            textColor={sc.value}
          />
        </View>
      </SettingsGroup>
    </>
  );

  const securityPage = (
    <>
      <SettingsGroup title="权限分级" sc={sc} bar={ACCENT}>
        <SettingRow label="无风险操作" value="自动执行" icon="lock" iconColor={ACCENT} sc={sc} />
        <SettingRow label="中风险操作" value="需确认" icon="lock" iconColor={ACCENT} sc={sc} />
        <SettingRow label="高风险操作" value="需确认" icon="lock" iconColor={ACCENT} sc={sc} />
        <SettingRow label="极高风险操作" value="默认拒绝" icon="shield" iconColor={ACCENT} sc={sc} last />
      </SettingsGroup>
      <SettingsGroup title="策略" sc={sc} bar={ACCENT}>
        <SettingRow
          label="工作区快照"
          icon="file-plus"
          iconColor={ACCENT}
          sc={sc}
          right={<AnimatedToggle value={settings.snapshot_enabled === 'true'} onValueChange={() => handleToggle('snapshot_enabled')} sc={sc} trackOn={INTERACTIVE} />}
        />
        <SettingRow
          label="Diff 审查"
          icon="file-text"
          iconColor={ACCENT}
          sc={sc}
          right={<AnimatedToggle value={settings.diff_review_enabled === 'true'} onValueChange={() => handleToggle('diff_review_enabled')} sc={sc} trackOn={INTERACTIVE} />}
          last
        />
      </SettingsGroup>
      <SettingsGroup title="授权管理" sc={sc} bar={ACCENT}>
        <SettingRow
          label="可信项目"
          value={`${trustedProjects.length} 个`}
          icon="shield"
          iconColor={ACCENT}
          sc={sc}
          onPress={() => setTrustModalVisible(true)}
        />
        <SettingRow label="操作审计日志" value="查看" icon="file-text" iconColor={ACCENT} sc={sc} onPress={fetchAuditLogs} />
        <SettingRow label="重置所有授权" icon="undo" danger sc={sc} onPress={resetPermissions} last />
      </SettingsGroup>
    </>
  );

  const skillsPage = (
    <>
      <SettingsGroup title="MCP 服务器" sc={sc} bar={ACCENT}>
        {mcpServers.length === 0 && (
          <SettingRow label="未配置 MCP 服务器" sc={sc} />
        )}
        {mcpServers.map((server) => (
          <View key={server.name} style={[styles.mcpRow, { borderBottomColor: sc.separator }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.mcpName, { color: sc.label }]} numberOfLines={1}>{server.name}</Text>
              <Text style={[styles.mcpPath, { color: sc.value }]} numberOfLines={1}>
                {server.transport === 'stdio'
                  ? `${server.command || ''} ${(server.args || []).join(' ')}`
                  : server.url || ''}
              </Text>
            </View>
            <Pressable onPress={() => removeMcpServer(server.name)} hitSlop={8} style={styles.mcpDelete}>
              <AppIcon name="trash-2" size={16} color={DANGER_COLOR} />
            </Pressable>
          </View>
        ))}
        <SettingRow
          label="添加 MCP 服务器"
          icon="plus"
          iconColor={ACCENT}
          sc={sc}
          onPress={openMcpModal}
          last={mcpServers.length === 0}
        />
      </SettingsGroup>
      <SettingsGroup title="已安装技能" sc={sc} bar={ACCENT}>
        {skills.length === 0 && <SettingRow label="暂无技能" sc={sc} last />}
        {skills.map((skill, idx) => (
          <SettingRow
            key={skill.name}
            label={skill.name}
            value={skill.description || '无描述'}
            icon="bolt"
            iconColor={ACCENT}
            sc={sc}
            onPress={() => showSkillDetail(skill.name)}
            right={<AnimatedToggle value={skill.enabled === 1} onValueChange={(v) => toggleSkill(skill.name, v)} sc={sc} trackOn={INTERACTIVE} />}
            last={idx === skills.length - 1}
          />
        ))}
      </SettingsGroup>
    </>
  );

  const storagePage = (
    <>
      <SettingsGroup title="存储" sc={sc} bar={ACCENT}>
        <SettingRow
          label="存储占用"
          value={storageSize}
          icon="database"
          iconColor={ACCENT}
          sc={sc}
          right={
            <Pressable onPress={calcStorage} hitSlop={8} style={styles.refreshBtn}>
              <AppIcon name="refresh-cw" size={16} color={sc.arrow} />
            </Pressable>
          }
          last
        />
      </SettingsGroup>
      <SettingsGroup title="数据备份" sc={sc} bar={ACCENT}>
        <SettingRow label="导出完整备份" value="JSON" icon="file-export" iconColor={ACCENT} sc={sc} onPress={exportBackup} />
        <SettingRow
          label="导入备份"
          value="粘贴 JSON"
          icon="file-import"
          iconColor={ACCENT}
          sc={sc}
          onPress={() => {
            setImportText('');
            setImportModalVisible(true);
          }}
        />
        <SettingRow label="导出日志" value="JSON" icon="file-text" iconColor={ACCENT} sc={sc} onPress={exportLogs} last />
      </SettingsGroup>
      <SettingsGroup title="诊断与维护" sc={sc} bar={ACCENT}>
        <SettingRow label="一键自检" value="运行" icon="shield" iconColor={ACCENT} sc={sc} onPress={runDiagnostics} />
        <SettingRow label="崩溃日志" value="查看" icon="file-text" iconColor={ACCENT} sc={sc} onPress={handleShowCrashLogs} />
        <SettingRow label="导出崩溃日志" icon="file-export" iconColor={ACCENT} sc={sc} onPress={exportCrashLogs} />
        <SettingRow label="清除缓存" icon="trash-2" danger sc={sc} onPress={handleClearCache} last />
      </SettingsGroup>
    </>
  );

  const aboutPage = (
    <>
      <SettingsGroup title="关于" sc={sc} bar={ACCENT}>
        <SettingRow label="版本" value={`v${appVersion}`} icon="info" iconColor={ACCENT} sc={sc} />
        <SettingRow
          label="检查更新"
          value={isUpdateAvailable ? '有新版本' : '已是最新'}
          icon="refresh-cw"
          iconColor={ACCENT}
          sc={sc}
          onPress={checkUpdate}
          right={
            isUpdateAvailable ? (
              <View style={styles.updateDotWrap}>
                <View style={styles.updateDot} />
              </View>
            ) : undefined
          }
        />
        <SettingRow label="隐私政策" value="查看" icon="lock" iconColor={ACCENT} sc={sc} onPress={() => setPrivacyVisible(true)} />
        <SettingRow label="使用指南" value="查看" icon="file-text" iconColor={ACCENT} sc={sc} onPress={() => setGuideVisible(true)} last />
      </SettingsGroup>
    </>
  );

  if (loading) {
    return (
      <Screen backgroundColor={colors.bgRoot} statusBarStyle={isDark ? 'light' : 'dark'} scrollable>
        <View style={styles.container}>
          <View style={styles.header}>
            <MenuButton onPress={onOpenSidebar} />
            <Text style={styles.headerTitle}>设置</Text>
          </View>
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>加载中...</Text>
          </View>
        </View>
      </Screen>
    );
  }

  const sectionTitle: Record<SectionKey, string> = {
    account: '账户与安全',
    ai: 'AI 模型',
    dev: '开发环境',
    appearance: '外观',
    security: '安全',
    skills: '技能与 MCP',
    storage: '存储与日志',
    about: '关于',
  };

  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle={isDark ? 'light' : 'dark'} scrollable>
      <View style={styles.container}>
        <View style={styles.header}>
          <MenuButton onPress={onOpenSidebar} />
          <Text style={styles.headerTitle}>设置</Text>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {section === null ? (
            <Animated.View key="main" entering={FadeIn.duration(200)}>
              {mainPage}
            </Animated.View>
          ) : (
            <Animated.View
              key={`sub-${section}`}
              entering={SlideInRight.duration(300).easing(Easing.out(Easing.ease))}
              exiting={FadeOutLeft.duration(200)}
            >
              <SubPageHeader
                title={sectionTitle[section]}
                onBack={() => setSection(null)}
                bar={ACCENT}
                colors={colors}
                styles={styles}
                right={
                  SECTION_KEYS[section].length > 0 ? (
                    <Pressable
                      style={[styles.saveBtn, { backgroundColor: ACCENT }]}
                      onPress={() => saveAll(SECTION_KEYS[section])}
                    >
                      <AppIcon name="check-circle" size={14} color="#FFFFFF" />
                      <Text style={styles.saveBtnText}>保存</Text>
                    </Pressable>
                  ) : undefined
                }
              />
              {section === 'account' && accountPage}
              {section === 'ai' && aiPage}
              {section === 'dev' && devPage}
              {section === 'appearance' && appearancePage}
              {section === 'security' && securityPage}
              {section === 'skills' && skillsPage}
              {section === 'storage' && storagePage}
              {section === 'about' && aboutPage}
            </Animated.View>
          )}
          <View style={{ height: 40 }} />
        </ScrollView>

        {saveFeedback && (
          <Animated.View
            key={saveFeedback.text}
            entering={FadeIn.duration(180)}
            exiting={FadeOutLeft.duration(180)}
            style={styles.saveToast}
            pointerEvents="none"
          >
            <AppIcon
              name={saveFeedback.type === 'success' ? 'check-circle' : saveFeedback.type === 'error' ? 'x-circle' : 'loader'}
              size={13}
              color={saveFeedback.type === 'success' ? colors.success : saveFeedback.type === 'error' ? colors.error : colors.primary}
            />
            <Text style={styles.saveToastText} numberOfLines={2}>
              {saveFeedback.text}
            </Text>
          </Animated.View>
        )}

        {/* 备份导出结果 Modal */}
        <Modal visible={backupModalVisible} transparent animationType="fade" onRequestClose={() => setBackupModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>导出成功</Text>
              <Text style={styles.modalEmptyText}>{backupSummary}</Text>
              <Text style={styles.modalHint}>
                文件已保存到应用文档目录（synaps-backup-*.json / synaps-logs-*.json），也可点击「复制 JSON」后粘贴到其它设备的「导入备份」。
              </Text>
              <View style={styles.modalButtons}>
                <Pressable style={[styles.modalBtn, styles.modalBtnCancel]} onPress={() => setBackupModalVisible(false)}>
                  <Text style={styles.modalBtnText}>关闭</Text>
                </Pressable>
                <Pressable style={[styles.modalBtn, styles.modalBtnSave]} onPress={copyBackup}>
                  <Text style={[styles.modalBtnText, styles.modalBtnTextSave]}>复制 JSON</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>


        {/* 隐私政策 Modal */}
        <Modal visible={privacyVisible} transparent animationType="fade" onRequestClose={() => setPrivacyVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>隐私政策</Text>
              <ScrollView style={{ maxHeight: 380 }}>
                <Text style={styles.modalHint}>
                  {'Synaps 隐私说明\n\n'}
                  {'1. 数据存储：你的 API Key、项目路径、GitHub Token 等配置仅保存在本机数据库与设置文件中，不会上传到任何第三方服务器。\n\n'}
                  {'2. 网络请求：Agent 功能仅与你配置的模型服务（如 DeepSeek API）及 GitHub 交互，用于完成你发起的任务。\n\n'}
                  {'3. 日志：操作审计日志与崩溃日志仅用于本地排查问题，导出需你主动操作。\n\n'}
                  {'4. 语音：语音识别与朗读使用系统能力，音频不会离开本机。\n\n'}
                  {'5. 删除：你可在设置页「清除所有数据」一键删除全部本地数据。'}
                </Text>
              </ScrollView>
              <View style={styles.modalButtons}>
                <Pressable style={[styles.modalBtn, styles.modalBtnSave]} onPress={() => setPrivacyVisible(false)}>
                  <Text style={[styles.modalBtnText, styles.modalBtnTextSave]}>知道了</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* 导入备份 Modal */}

        <Modal visible={importModalVisible} transparent animationType="fade" onRequestClose={() => setImportModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>导入备份</Text>
              <TextInput
                style={[styles.modalInput, { minHeight: 160, textAlignVertical: 'top' }]}
                placeholder={'粘贴完整的备份 JSON（{"meta":...,"tables":{...}}）'}
                placeholderTextColor={colors.textMuted}
                value={importText}
                onChangeText={setImportText}
                multiline
                autoCapitalize="none"
              />
              <Text style={styles.modalHint}>导入会覆盖当前全部数据，建议先导出一次备份。</Text>
              <View style={styles.modalButtons}>
                <Pressable style={[styles.modalBtn, styles.modalBtnCancel]} onPress={() => setImportModalVisible(false)}>
                  <Text style={styles.modalBtnText}>取消</Text>
                </Pressable>
                <Pressable
                  style={[styles.modalBtn, styles.modalBtnSave, importing && styles.modalBtnDisabled]}
                  onPress={importBackup}
                >
                  <Text style={[styles.modalBtnText, styles.modalBtnTextSave]}>{importing ? '导入中...' : '导入'}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* 一键自检 Modal */}
        <Modal visible={diagnosticsVisible} transparent animationType="fade" onRequestClose={() => setDiagnosticsVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>一键自检</Text>
              {diagnosticsData === null ? (
                <Text style={styles.modalEmptyText}>正在检查...</Text>
              ) : diagnosticsData.error ? (
                <Text style={styles.modalEmptyText}>自检失败：{diagnosticsData.error}</Text>
              ) : (
                <ScrollView style={{ maxHeight: 380 }}>
                  {renderDiagnostics(diagnosticsData).map((row, i) => (
                    <View key={i} style={styles.diagItem}>
                      <Text style={[styles.diagStatus, row.ok ? styles.diagOk : styles.diagBad]}>{row.ok ? '✓' : '✗'}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.diagLabel}>{row.label}</Text>
                        <Text style={styles.diagDetail}>{row.detail}</Text>
                      </View>
                    </View>
                  ))}
                </ScrollView>
              )}
              <Pressable style={[styles.modalBtn, styles.modalBtnSave, styles.modalBtnFull]} onPress={() => setDiagnosticsVisible(false)}>
                <Text style={[styles.modalBtnText, styles.modalBtnTextSave]}>关闭</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {/* 使用指南 Modal */}
        <Modal visible={guideVisible} transparent animationType="fade" onRequestClose={() => setGuideVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>使用指南</Text>
              <ScrollView style={{ maxHeight: 420 }}>
                <Text style={styles.guideSection}>快速开始</Text>
                <Text style={styles.guideText}>1. 在「项目」页新建或导入项目（可用模板一键生成骨架）</Text>
                <Text style={styles.guideText}>2. 进入「Agent」页与 AI 对话，直接描述开发任务</Text>
                <Text style={styles.guideText}>3. Agent 会自动读写代码、执行命令、验证结果并推送</Text>
                <Text style={styles.guideSection}>核心能力</Text>
                <Text style={styles.guideText}>· 执行命令 / 运行程序 / Git 操作 / 触发构建 / 安装 APK</Text>
                <Text style={styles.guideText}>· 独立 Agent：10 种角色，各有专属上下文与工具白名单</Text>
                <Text style={styles.guideText}>· 设备控制：开启无障碍后 Agent 可点击、滑动、截图、读屏</Text>
                <Text style={styles.guideText}>· MCP 服务器：接入 GitHub / Jira / Slack 等外部工具</Text>
                <Text style={styles.guideSection}>修复闭环</Text>
                <Text style={styles.guideText}>说「修复我」或「检查代码并修复」，Agent 会自动执行 lint → 类型检查 → 安全扫描 → 测试 → 提交 → 构建 → 安装。</Text>
                <Text style={styles.guideSection}>常见问题</Text>
                <Text style={styles.guideText}>· 顶部出现离线横幅：说明内嵌后端未启动，Agent / 终端功能不可用</Text>
                <Text style={styles.guideText}>· 工具调用无响应：运行「一键自检」查看配置，确认 AI Key 已填写</Text>
                <Text style={styles.guideText}>· 换机迁移：设置 → 存储与日志 → 导出完整备份，另一台设备导入</Text>
                <Text style={styles.guideSection}>更新日志</Text>
                <Text style={styles.guideText}>v1.1.0 · 项目模板、全量备份导入导出、一键自检、离线提示、使用指南</Text>
                <Text style={styles.guideText}>v1.0.0 · 双栏任务面板、独立 Agent 架构、设备控制、DeepSeek Harness</Text>
              </ScrollView>
              <Pressable style={[styles.modalBtn, styles.modalBtnSave, styles.modalBtnFull]} onPress={() => setGuideVisible(false)}>
                <Text style={[styles.modalBtnText, styles.modalBtnTextSave]}>关闭</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {/* 可信项目 Modal */}
        <Modal visible={trustModalVisible} transparent animationType="fade" onRequestClose={() => setTrustModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>可信项目</Text>
              <Text style={styles.modalHint}>标记为可信后，中/高风险操作将自动批准，不再弹窗确认</Text>
              <ScrollView style={{ maxHeight: 320 }}>
                {projects.length === 0 && <Text style={styles.modalEmptyText}>暂无项目，请先创建</Text>}
                {projects.map((project) => (
                  <View key={project.id} style={styles.trustItem}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.trustItemName} numberOfLines={1}>{project.name}</Text>
                      <Text style={styles.trustItemPath} numberOfLines={1}>{project.path}</Text>
                    </View>
                    <AnimatedToggle
                      value={trustedProjects.includes(project.id)}
                      onValueChange={() => toggleTrust(project.id)}
                      sc={sc}
                      trackOn={INTERACTIVE}
                    />
                  </View>
                ))}
              </ScrollView>
              <Pressable style={[styles.modalBtn, styles.modalBtnSave, styles.modalBtnFull]} onPress={() => setTrustModalVisible(false)}>
                <Text style={[styles.modalBtnText, styles.modalBtnTextSave]}>完成</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {/* 审计日志 Modal */}
        <Modal visible={auditModalVisible} transparent animationType="fade" onRequestClose={() => setAuditModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>操作审计日志</Text>
              <ScrollView style={{ maxHeight: 400 }}>
                {auditLogs.length === 0 && <Text style={styles.modalEmptyText}>暂无记录</Text>}
                {auditLogs.map((log) => (
                  <View key={log.id} style={styles.auditItem}>
                    <View style={styles.auditHeader}>
                      <Text style={styles.auditAction}>{log.action}</Text>
                      <Text
                        style={[
                          styles.auditBadge,
                          log.risk_level === 'high'
                            ? styles.auditBadgeHigh
                            : log.risk_level === 'critical'
                              ? styles.auditBadgeCritical
                              : styles.auditBadgeMedium,
                        ]}
                      >
                        {riskLabel(log.risk_level)}
                      </Text>
                    </View>
                    <Text style={styles.auditDetail} numberOfLines={2}>{log.detail}</Text>
                    <Text style={styles.auditMeta}>{decisionLabel(log.decision)} · {log.created_at}</Text>
                  </View>
                ))}
              </ScrollView>
              <Pressable style={[styles.modalBtn, styles.modalBtnSave, styles.modalBtnFull]} onPress={() => setAuditModalVisible(false)}>
                <Text style={[styles.modalBtnText, styles.modalBtnTextSave]}>关闭</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {/* MCP 添加 Modal */}
        <Modal visible={mcpModalVisible} transparent animationType="fade" onRequestClose={() => setMcpModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>添加 MCP 服务器</Text>
              <TextInput
                style={styles.modalInput}
                placeholder="服务器名称（如 github）"
                placeholderTextColor={colors.textMuted}
                value={mcpFormName}
                onChangeText={setMcpFormName}
                autoCapitalize="none"
              />
              <View style={styles.transportRow}>
                <Pressable
                  style={[styles.transportBtn, mcpFormTransport === 'stdio' && styles.transportBtnActive]}
                  onPress={() => setMcpFormTransport('stdio')}
                >
                  <Text style={[styles.transportBtnText, mcpFormTransport === 'stdio' && styles.transportBtnTextActive]}>stdio</Text>
                </Pressable>
                <Pressable
                  style={[styles.transportBtn, mcpFormTransport === 'sse' && styles.transportBtnActive]}
                  onPress={() => setMcpFormTransport('sse')}
                >
                  <Text style={[styles.transportBtnText, mcpFormTransport === 'sse' && styles.transportBtnTextActive]}>sse</Text>
                </Pressable>
              </View>
              {mcpFormTransport === 'stdio' ? (
                <>
                  <TextInput
                    style={styles.modalInput}
                    placeholder="启动命令（如 npx）"
                    placeholderTextColor={colors.textMuted}
                    value={mcpFormCommand}
                    onChangeText={setMcpFormCommand}
                    autoCapitalize="none"
                  />
                  <TextInput
                    style={styles.modalInput}
                    placeholder="参数（逗号分隔，如 -y @modelcontextprotocol/server-github）"
                    placeholderTextColor={colors.textMuted}
                    value={mcpFormArgs}
                    onChangeText={setMcpFormArgs}
                    autoCapitalize="none"
                  />
                </>
              ) : (
                <TextInput
                  style={styles.modalInput}
                  placeholder="SSE URL（如 https://example.com/sse）"
                  placeholderTextColor={colors.textMuted}
                  value={mcpFormUrl}
                  onChangeText={setMcpFormUrl}
                  autoCapitalize="none"
                  keyboardType="url"
                />
              )}
              <View style={styles.modalButtons}>
                <Pressable style={[styles.modalBtn, styles.modalBtnCancel]} onPress={() => setMcpModalVisible(false)}>
                  <Text style={styles.modalBtnText}>取消</Text>
                </Pressable>
                <Pressable style={[styles.modalBtn, styles.modalBtnSave]} onPress={saveMcpServer}>
                  <Text style={[styles.modalBtnText, styles.modalBtnTextSave]}>保存</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
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
    loadingContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    loadingText: {
      color: colors.textSecondary,
      fontSize: fontSize.md,
    },
    saveToast: {
      position: 'absolute',
      top: 64,
      alignSelf: 'center',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 20,
      backgroundColor: colors.bgCard,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.15,
      shadowRadius: 6,
      elevation: 4,
      zIndex: 999,
      maxWidth: '86%',
    },
    saveToastText: {
      fontSize: 13,
      color: colors.textPrimary,
      flexShrink: 1,
    },
    updateDotWrap: {
      paddingHorizontal: 2,
      paddingVertical: 2,
    },
    updateDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: '#F44336',
    },
    subHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: spacing.md,
    },
    backBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    subHeaderTitle: {
      flex: 1,
      fontSize: fontSize.lg,
      fontWeight: '700',
      marginLeft: spacing.xs,
    },
    saveBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.md,
    },
    saveBtnText: {
      fontSize: 13,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    fieldRow: {
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    fieldLabel: {
      fontSize: 12,
      fontWeight: '500',
      marginBottom: 4,
    },
    fieldValue: {
      fontSize: 14,
      paddingBottom: 6,
    },
    segmentBlock: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    avatarRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 14,
    },
    avatar: {
      width: 52,
      height: 52,
      borderRadius: 26,
      alignItems: 'center',
      justifyContent: 'center',
    },
    refreshBtn: {
      padding: 4,
    },
    clearCard: {
      marginTop: 4,
      marginBottom: 12,
      borderRadius: 12,
      borderWidth: 1,
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    clearText: {
      fontSize: 14,
      fontWeight: '600',
    },
    accentRow: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    accentItem: {
      alignItems: 'center',
      gap: 4,
    },
    accentSwatch: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: 'transparent',
    },
    accentSwatchActive: {
      borderColor: colors.textPrimary,
    },
    accentLabel: {
      fontSize: 11,
    },
    mcpRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      minHeight: 48,
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    mcpName: {
      fontSize: 14,
      fontWeight: '500',
    },
    mcpPath: {
      fontSize: 12,
      marginTop: 2,
    },
    mcpDelete: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.7)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: spacing.xl,
    },
    modalContent: {
      width: '100%',
      maxWidth: 400,
      backgroundColor: colors.bgCard,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.xl,
    },
    modalTitle: {
      fontSize: fontSize.lg,
      fontWeight: '700',
      color: colors.textPrimary,
      marginBottom: spacing.lg,
    },
    modalInput: {
      backgroundColor: colors.bgElevated,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      fontSize: fontSize.md,
      color: colors.textPrimary,
      marginBottom: spacing.lg,
    },
    modalButtons: {
      flexDirection: 'row',
      gap: spacing.md,
      justifyContent: 'flex-end',
    },
    modalBtn: {
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.sm + 2,
      borderRadius: radius.md,
    },
    modalBtnCancel: {
      backgroundColor: colors.bgElevated,
    },
    modalBtnSave: {
      backgroundColor: colors.primary,
    },
    modalBtnText: {
      fontSize: fontSize.md,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    modalBtnTextSave: {
      color: '#FFFFFF',
    },
    modalHint: {
      fontSize: fontSize.sm,
      color: colors.textSecondary,
      marginBottom: spacing.lg,
      lineHeight: 18,
    },
    modalEmptyText: {
      fontSize: fontSize.sm,
      color: colors.textMuted,
      textAlign: 'center',
      paddingVertical: spacing.xl,
    },
    modalBtnFull: {
      alignSelf: 'stretch',
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.md,
      paddingVertical: spacing.md,
    },
    modalBtnDisabled: {
      opacity: 0.5,
    },
    trustItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.separator,
      gap: spacing.md,
    },
    trustItemName: {
      fontSize: fontSize.md,
      color: colors.textPrimary,
      fontWeight: '600',
    },
    trustItemPath: {
      fontSize: fontSize.xs,
      color: colors.textMuted,
      marginTop: 2,
    },
    auditItem: {
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.separator,
    },
    auditHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.xs,
    },
    auditAction: {
      fontSize: fontSize.sm,
      color: colors.textPrimary,
      fontWeight: '600',
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    auditBadge: {
      fontSize: 10,
      fontWeight: '700',
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.sm,
      overflow: 'hidden',
    },
    auditBadgeMedium: {
      color: colors.warning,
      backgroundColor: 'rgba(251,191,36,0.12)',
    },
    auditBadgeHigh: {
      color: colors.error,
      backgroundColor: 'rgba(239,68,68,0.12)',
    },
    auditBadgeCritical: {
      color: '#FFFFFF',
      backgroundColor: colors.error,
    },
    auditDetail: {
      fontSize: fontSize.sm,
      color: colors.textSecondary,
    },
    auditMeta: {
      fontSize: 10,
      color: colors.textMuted,
      marginTop: 4,
    },
    transportRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginBottom: spacing.lg,
    },
    transportBtn: {
      flex: 1,
      height: 40,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.bgElevated,
    },
    transportBtnActive: {
      borderColor: colors.primary,
      backgroundColor: colors.primaryGlow,
    },
    transportBtnText: {
      fontSize: fontSize.sm,
      color: colors.textSecondary,
      fontWeight: '600',
    },
    transportBtnTextActive: {
      color: colors.primary,
    },
    diagItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.separator,
    },
    diagStatus: {
      width: 20,
      fontSize: fontSize.md,
      fontWeight: '700',
      textAlign: 'center',
    },
    diagOk: {
      color: colors.success,
    },
    diagBad: {
      color: colors.error,
    },
    diagLabel: {
      fontSize: fontSize.sm,
      color: colors.textPrimary,
      fontWeight: '600',
    },
    diagDetail: {
      fontSize: fontSize.xs,
      color: colors.textMuted,
      marginTop: 2,
      lineHeight: 15,
    },
    guideSection: {
      fontSize: fontSize.sm,
      color: colors.primary,
      fontWeight: '700',
      marginTop: spacing.md,
      marginBottom: spacing.xs,
    },
    guideText: {
      fontSize: fontSize.sm,
      color: colors.textSecondary,
      lineHeight: 19,
      marginBottom: 4,
    },
  });
