import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable, TextInput,
  ScrollView, RefreshControl, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { getApiBase } from '@/utils';
import { useThemeColors } from '@/components/ThemeProvider';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ModuleKey } from '@/components/Sidebar';

const API_BASE = getApiBase();
const ACCENT = '#3A3A3A';
type TabKey = 'overview' | 'rules' | 'logs' | 'memory';

interface CollectorProps {
  onOpenSidebar: () => void;
}

// ==================== Overview ====================

function OverviewTab() {
  const [overview, setOverview] = useState<any>(null);
  const [rules, setRules] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const { colors } = useThemeColors();

  const fetchOverview = useCallback(async () => {
    try {
      const [ovRes, rlRes] = await Promise.all([
        fetch(`${API_BASE}/api/v1/telegram/overview`),
        fetch(`${API_BASE}/api/v1/telegram/rules`),
      ]);
      if (ovRes.ok) setOverview(await ovRes.json());
      if (rlRes.ok) setRules(await rlRes.json());
    } catch {}
  }, []);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchOverview();
    setRefreshing(false);
  }, [fetchOverview]);

  const stats = [
    { label: '今日采集', value: overview?.today ?? '-', icon: 'calendar' as const },
    { label: '累计采集', value: overview?.total ?? '-', icon: 'database' as const },
    { label: '成功', value: overview?.success ?? '-', icon: 'check-circle' as const, color: colors.success },
    { label: '失败', value: overview?.failed ?? '-', icon: 'x-circle' as const, color: colors.error },
    { label: '采集规则', value: overview?.rules ?? '-', icon: 'sliders' as const },
  ];

  const runningRules = rules.filter(r => r.status === 'backfilling' || r.status === 'monitoring');

  return (
    <ScrollView style={styles.tabContent} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}>
      <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>运行总览</Text>
      <View style={styles.statsGrid}>
        {stats.map(s => (
          <View key={s.label} style={[styles.statCard, { backgroundColor: colors.bgElevated, borderColor: colors.separator }]}>
            <Feather name={s.icon} size={16} color={s.color || colors.textSecondary} />
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>{s.value}</Text>
            <Text style={[styles.statLabel, { color: colors.textMuted }]}>{s.label}</Text>
          </View>
        ))}
      </View>
      <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>运行中任务</Text>
      {runningRules.length === 0 ? (
        <Text style={[styles.emptyText, { color: colors.textMuted }]}>暂无运行中的采集任务</Text>
      ) : runningRules.map(r => (
        <View key={r.id} style={[styles.ruleCard, { backgroundColor: colors.bgElevated, borderColor: colors.separator }]}>
          <View style={styles.ruleHeader}>
            <Text style={[styles.ruleName, { color: colors.textPrimary }]}>{r.name}</Text>
            <View style={[styles.statusBadge, { backgroundColor: colors.success + '22' }]}>
              <Text style={{ color: colors.success, fontSize: 11 }}>{r.status === 'backfilling' ? '回采中' : '监控中'}</Text>
            </View>
          </View>
          <Text style={[styles.ruleMeta, { color: colors.textMuted }]}>
            来源 {r.sourceChannels?.length || 0} 个 → 目标 {r.targetChannels?.length || 0} 个
          </Text>
        </View>
      ))}
      <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>全部规则</Text>
      {rules.length === 0 ? (
        <Text style={[styles.emptyText, { color: colors.textMuted }]}>暂无采集规则，去「规则」页创建</Text>
      ) : rules.map(r => (
        <View key={r.id} style={[styles.ruleCard, { backgroundColor: colors.bgElevated, borderColor: colors.separator }]}>
          <Text style={[styles.ruleName, { color: colors.textPrimary }]}>{r.name}</Text>
          <Text style={[styles.ruleMeta, { color: colors.textMuted }]}>
            {r.status || 'stopped'} · 来源 {r.sourceChannels?.length || 0} → 目标 {r.targetChannels?.length || 0}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

// ==================== Rules ====================

function RulesTab() {
  const [rules, setRules] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [channels, setChannels] = useState<{ sources: any[]; targets: any[] }>({ sources: [], targets: [] });
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [captionMode, setCaptionMode] = useState('keep');
  const { colors } = useThemeColors();

  const fetchRules = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/telegram/rules`);
      if (res.ok) setRules(await res.json());
    } catch {}
  }, []);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/telegram/channels`);
      if (res.ok) setChannels(await res.json());
    } catch {}
  }, []);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchRules();
    setRefreshing(false);
  }, [fetchRules]);

  const createRule = useCallback(async () => {
    if (!newName.trim() || selectedSources.length === 0 || selectedTargets.length === 0) return;
    try {
      const res = await fetch(`${API_BASE}/api/v1/telegram/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          sourceChannels: selectedSources.map(id => channels.sources.find((s: any) => String(s.id) === id)).filter(Boolean),
          targetChannels: selectedTargets.map(id => channels.targets.find((t: any) => String(t.id) === id)).filter(Boolean),
          captionMode,
          dedupe: true,
          stripLinks: captionMode === 'stripLinks',
          stripMentions: captionMode === 'stripMentions',
          watermark: true,
          forwardMode: 'auto',
          intervalSec: 15,
        }),
      });
      if (res.ok) {
        setShowCreate(false);
        setNewName('');
        setSelectedSources([]);
        setSelectedTargets([]);
        fetchRules();
      }
    } catch {}
  }, [newName, selectedSources, selectedTargets, captionMode, channels, fetchRules]);

  const startRule = useCallback(async (id: string) => {
    try {
      await fetch(`${API_BASE}/api/v1/telegram/rules/${id}/start`, { method: 'POST' });
      fetchRules();
    } catch {}
  }, [fetchRules]);

  const stopRule = useCallback(async (id: string) => {
    try {
      await fetch(`${API_BASE}/api/v1/telegram/rules/${id}/stop`, { method: 'POST' });
      fetchRules();
    } catch {}
  }, [fetchRules]);

  const deleteRule = useCallback(async (id: string) => {
    try {
      await fetch(`${API_BASE}/api/v1/telegram/rules/${id}`, { method: 'DELETE' });
      fetchRules();
    } catch {}
  }, [fetchRules]);

  const openCreate = useCallback(() => {
    setShowCreate(true);
    fetchChannels();
  }, [fetchChannels]);

  const toggleItem = (list: string[], setList: (v: string[]) => void, id: string) => {
    setList(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  };

  const statusColor = (status: string) => {
    if (status === 'monitoring') return colors.success;
    if (status === 'backfilling') return colors.warning;
    if (status === 'error') return colors.error;
    return colors.textMuted;
  };

  return (
    <View style={styles.tabContent}>
      <FlatList
        data={rules}
        keyExtractor={(item: any) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}
        ListHeaderComponent={
          <Pressable style={[styles.createBtn, { backgroundColor: ACCENT }]} onPress={openCreate}>
            <Feather name="plus" size={14} color="#fff" />
            <Text style={styles.createBtnText}>新建采集规则</Text>
          </Pressable>
        }
        ListEmptyComponent={<Text style={[styles.emptyText, { color: colors.textMuted }]}>暂无规则</Text>}
        renderItem={({ item: r }: { item: any }) => (
          <View style={[styles.ruleCard, { backgroundColor: colors.bgElevated, borderColor: colors.separator }]}>
            <View style={styles.ruleHeader}>
              <Text style={[styles.ruleName, { color: colors.textPrimary }]}>{r.name}</Text>
              <View style={[styles.statusBadge, { backgroundColor: statusColor(r.status) + '22' }]}>
                <Text style={{ color: statusColor(r.status), fontSize: 11 }}>
                  {r.status === 'monitoring' ? '监控中' : r.status === 'backfilling' ? '回采中' : r.status === 'error' ? '异常' : '已停止'}
                </Text>
              </View>
            </View>
            <Text style={[styles.ruleMeta, { color: colors.textMuted }]}>
              来源 {r.sourceChannels?.length || 0} 个 → 目标 {r.targetChannels?.length || 0} 个 · 间隔 {r.intervalSec}s
            </Text>
            <Text style={[styles.ruleMeta, { color: colors.textMuted }]}>
              类型 {r.msgType} · 去重 {r.dedupe ? '开' : '关'} · 加工 {r.captionMode} · 模式 {r.forwardMode}
            </Text>
            <View style={styles.ruleActions}>
              {r.status === 'monitoring' || r.status === 'backfilling' ? (
                <Pressable style={[styles.actionBtn, { backgroundColor: colors.error + '22' }]} onPress={() => stopRule(r.id)}>
                  <Feather name="square" size={12} color={colors.error} />
                  <Text style={{ color: colors.error, fontSize: 12 }}>停止</Text>
                </Pressable>
              ) : (
                <Pressable style={[styles.actionBtn, { backgroundColor: colors.success + '22' }]} onPress={() => startRule(r.id)}>
                  <Feather name="play" size={12} color={colors.success} />
                  <Text style={{ color: colors.success, fontSize: 12 }}>启动</Text>
                </Pressable>
              )}
              <Pressable style={[styles.actionBtn, { backgroundColor: colors.error + '22' }]} onPress={() => deleteRule(r.id)}>
                <Feather name="trash-2" size={12} color={colors.error} />
              </Pressable>
            </View>
          </View>
        )}
      />

      {/* Create Modal */}
      {showCreate && (
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.bgElevated }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>新建采集规则</Text>
            <TextInput
              style={[styles.modalInput, { color: colors.textPrimary, borderColor: colors.separator }]}
              placeholder="规则名称，如 AI 资讯"
              placeholderTextColor={colors.textMuted}
              value={newName}
              onChangeText={setNewName}
            />
            <Text style={[styles.modalLabel, { color: colors.textSecondary }]}>来源频道（可多选）</Text>
            <ScrollView style={styles.chipScroll}>
              {channels.sources.map((ch: any) => (
                <Pressable
                  key={ch.id}
                  style={[styles.chip, selectedSources.includes(String(ch.id)) && styles.chipActive]}
                  onPress={() => toggleItem(selectedSources, setSelectedSources, String(ch.id))}
                >
                  <Text style={styles.chipText}>{ch.title}</Text>
                </Pressable>
              ))}
              {channels.sources.length === 0 && <Text style={[styles.emptyText, { color: colors.textMuted }]}>加载中...</Text>}
            </ScrollView>
            <Text style={[styles.modalLabel, { color: colors.textSecondary }]}>目标频道</Text>
            <ScrollView style={styles.chipScroll}>
              {channels.targets.map((ch: any) => (
                <Pressable
                  key={ch.id}
                  style={[styles.chip, selectedTargets.includes(String(ch.id)) && styles.chipActive]}
                  onPress={() => toggleItem(selectedTargets, setSelectedTargets, String(ch.id))}
                >
                  <Text style={styles.chipText}>{ch.title}</Text>
                </Pressable>
              ))}
              {channels.targets.length === 0 && <Text style={[styles.emptyText, { color: colors.textMuted }]}>加载中...</Text>}
            </ScrollView>
            <Text style={[styles.modalLabel, { color: colors.textSecondary }]}>文案加工</Text>
            <View style={styles.chipRow}>
              {[['keep', '原样'], ['strip', '去文字'], ['stripLinks', '去链接'], ['stripMentions', '去@'], ['rewrite', 'AI重写']].map(([val, label]) => (
                <Pressable
                  key={val}
                  style={[styles.chip, captionMode === val && styles.chipActive]}
                  onPress={() => setCaptionMode(val)}
                >
                  <Text style={styles.chipText}>{label}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.modalActions}>
              <Pressable style={[styles.modalBtn, { backgroundColor: colors.separator }]} onPress={() => setShowCreate(false)}>
                <Text style={{ color: colors.textSecondary }}>取消</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, { backgroundColor: ACCENT, opacity: (!newName.trim() || selectedSources.length === 0 || selectedTargets.length === 0) ? 0.5 : 1 }]}
                onPress={createRule}
              >
                <Text style={{ color: '#fff' }}>创建</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

// ==================== Logs ====================

function LogsTab() {
  const [logs, setLogs] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const { colors } = useThemeColors();

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/telegram/logs?limit=50`);
      if (res.ok) setLogs(await res.json());
    } catch {}
  }, []);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchLogs();
    setRefreshing(false);
  }, [fetchLogs]);

  const statusIcon = (status: string) => {
    if (status === 'success') return <Feather name="check-circle" size={12} color={colors.success} />;
    if (status === 'failed') return <Feather name="x-circle" size={12} color={colors.error} />;
    if (status === 'skipped') return <Feather name="skip-forward" size={12} color={colors.textMuted} />;
    return <Feather name="circle" size={12} color={colors.textMuted} />;
  };

  return (
    <FlatList
      data={logs}
      keyExtractor={(item: any) => item.id}
      style={styles.tabContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}
      ListEmptyComponent={<Text style={[styles.emptyText, { color: colors.textMuted, marginTop: 40 }]}>暂无采集日志</Text>}
      renderItem={({ item: log }: { item: any }) => (
        <View style={[styles.logItem, { borderBottomColor: colors.separator }]}>
          <View style={styles.logRow}>
            {statusIcon(log.status)}
            <Text style={[styles.logType, { color: colors.textSecondary }]}>{log.msg_type}</Text>
            <Text style={[styles.logTime, { color: colors.textMuted }]}>
              {log.duration_ms ? `${log.duration_ms}ms` : ''}
            </Text>
          </View>
          <Text style={[styles.logSource, { color: colors.textPrimary }]} numberOfLines={2}>
            {log.raw_text || '(无文字)'}
          </Text>
          <Text style={[styles.logMeta, { color: colors.textMuted }]}>
            ch:{log.source_channel} → {log.target_channel} · {log.status}
          </Text>
        </View>
      )}
    />
  );
}

// ==================== Memory ====================

function MemoryTab() {
  const [query, setQuery] = useState('');
  const [memory, setMemory] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const { colors } = useThemeColors();

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/telegram/memory?q=${encodeURIComponent(query.trim())}&limit=20`);
      if (res.ok) setMemory(await res.json());
    } catch {}
    setSearching(false);
  }, [query]);

  return (
    <View style={styles.tabContent}>
      <View style={styles.searchRow}>
        <TextInput
          style={[styles.searchInput, { color: colors.textPrimary, borderColor: colors.separator, backgroundColor: colors.bgElevated }]}
          placeholder="搜索记忆点..."
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={search}
          returnKeyType="search"
        />
        <Pressable style={[styles.searchBtn, { backgroundColor: ACCENT }]} onPress={search}>
          <Feather name="search" size={16} color="#fff" />
        </Pressable>
      </View>
      {searching && <ActivityIndicator style={{ marginTop: 20 }} color={ACCENT} />}
      <FlatList
        data={memory}
        keyExtractor={(item: any) => item.id}
        renderItem={({ item: m }: { item: any }) => (
          <View style={[styles.memoryItem, { borderBottomColor: colors.separator }]}>
            <Text style={[styles.memoryTitle, { color: colors.textPrimary }]} numberOfLines={2}>{m.title}</Text>
            <Text style={[styles.memoryChunk, { color: colors.textSecondary }]} numberOfLines={4}>{m.chunk}</Text>
            <Text style={[styles.memoryTime, { color: colors.textMuted }]}>{m.created_at}</Text>
          </View>
        )}
        ListEmptyComponent={!searching ? <Text style={[styles.emptyText, { color: colors.textMuted, marginTop: 40 }]}>输入关键词搜索采集记忆</Text> : null}
      />
    </View>
  );
}

// ==================== Main ====================

export default function CollectorScreen({ onOpenSidebar }: CollectorProps) {
  const [tab, setTab] = useState<TabKey>('overview');
  const [loginStatus, setLoginStatus] = useState<any>(null);
  const { colors } = useThemeColors();

  useEffect(() => {
    fetch(`${API_BASE}/api/v1/telegram/status`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setLoginStatus(d))
      .catch(() => {});
  }, []);

  const tabs: { key: TabKey; label: string; icon: React.ComponentProps<typeof Feather>['name'] }[] = [
    { key: 'overview', label: '总览', icon: 'layout' },
    { key: 'rules', label: '规则', icon: 'sliders' },
    { key: 'logs', label: '日志', icon: 'file-text' },
    { key: 'memory', label: '记忆', icon: 'database' },
  ];

  const renderContent = () => {
    switch (tab) {
      case 'overview': return <OverviewTab />;
      case 'rules': return <RulesTab />;
      case 'logs': return <LogsTab />;
      case 'memory': return <MemoryTab />;
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bgRoot }]} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <Pressable onPress={onOpenSidebar} hitSlop={8} style={styles.backBtn}>
          <Feather name="menu" size={20} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>📡 采集</Text>
          <Text style={[styles.headerSub, { color: colors.textMuted }]}>
            {loginStatus?.loggedIn ? `已连接 · ${loginStatus.phone || ''}` : '未登录'}
          </Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      {/* Tabs */}
      <View style={[styles.tabBar, { borderBottomColor: colors.separator }]}>
        {tabs.map(t => (
          <Pressable
            key={t.key}
            style={[styles.tabItem, tab === t.key && { borderBottomColor: ACCENT }]}
            onPress={() => setTab(t.key)}
          >
            <Feather name={t.icon} size={14} color={tab === t.key ? ACCENT : colors.textMuted} />
            <Text style={[styles.tabLabel, { color: tab === t.key ? ACCENT : colors.textMuted }]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {/* Content */}
      {renderContent()}

      {/* Login warning */}
      {loginStatus && !loginStatus.loggedIn && !loginStatus.pendingLogin && (
        <View style={[styles.loginWarn, { backgroundColor: colors.warning + '22' }]}>
          <Feather name="alert-triangle" size={14} color={colors.warning} />
          <Text style={[styles.loginWarnText, { color: colors.textSecondary }]}>
            请在「设置 → Telegram 转发器」中登录账号后使用
          </Text>
        </View>
      )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ==================== Styles ====================


const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  backBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '700' },
  headerSub: { fontSize: 11, marginTop: 2 },
  tabBar: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tabItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabLabel: { fontSize: 12, fontWeight: '500' },
  tabContent: { flex: 1 },
  sectionTitle: { fontSize: 13, fontWeight: '600', marginTop: 16, marginBottom: 8, marginLeft: 16 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, gap: 8 },
  statCard: { width: '31%', paddingVertical: 12, paddingHorizontal: 10, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  statValue: { fontSize: 18, fontWeight: '700', marginTop: 4 },
  statLabel: { fontSize: 10, marginTop: 2 },
  ruleCard: { marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  ruleHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  ruleName: { fontSize: 14, fontWeight: '600' },
  statusBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  ruleMeta: { fontSize: 11, marginTop: 4 },
  ruleActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  createBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginHorizontal: 16, marginVertical: 12, paddingVertical: 10, borderRadius: 10 },
  createBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  emptyText: { fontSize: 13, textAlign: 'center', marginTop: 20 },
  logItem: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  logRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  logType: { fontSize: 12, fontWeight: '500' },
  logTime: { fontSize: 10, marginLeft: 'auto' },
  logSource: { fontSize: 12, marginTop: 4 },
  logMeta: { fontSize: 10, marginTop: 2 },
  searchRow: { flexDirection: 'row', gap: 8, padding: 12 },
  searchInput: { flex: 1, height: 38, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, fontSize: 13 },
  searchBtn: { width: 38, height: 38, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  memoryItem: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  memoryTitle: { fontSize: 13, fontWeight: '600' },
  memoryChunk: { fontSize: 12, marginTop: 4, lineHeight: 17 },
  memoryTime: { fontSize: 10, marginTop: 4 },
  modalOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  modalCard: { borderRadius: 14, padding: 20, maxHeight: '80%' },
  modalTitle: { fontSize: 16, fontWeight: '700', marginBottom: 12 },
  modalInput: { height: 40, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, fontSize: 13, marginBottom: 12 },
  modalLabel: { fontSize: 12, fontWeight: '600', marginBottom: 6 },
  chipScroll: { maxHeight: 120, marginBottom: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: '#2A2A2E' },
  chipActive: { backgroundColor: '#7C3AED' },
  chipText: { color: '#fff', fontSize: 12 },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  modalBtn: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 8 },
  loginWarn: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, margin: 12, borderRadius: 8 },
  loginWarnText: { fontSize: 12, flex: 1 },
});
