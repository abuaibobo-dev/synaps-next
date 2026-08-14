import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, Alert, Modal, Switch, Platform } from 'react-native';
import { Screen } from '@/components/Screen';
import { MenuButton } from '@/components/Sidebar';
import { colors, spacing, radius, fontSize } from '@/utils/theme';
import { getApiBase } from '@/utils';
import { getCrashLogs, clearCrashLogs } from '@/utils/crashReporter';
const API_BASE = getApiBase();
import { FontAwesome6 } from '@expo/vector-icons';


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
};

interface EditModalProps {
  visible: boolean;
  title: string;
  value: string;
  placeholder?: string;
  secure?: boolean;
  onClose: () => void;
  onSave: (value: string) => void;
}

function EditModal({ visible, title, value, placeholder, secure, onClose, onSave }: EditModalProps) {
  const [inputValue, setInputValue] = useState(value);

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>{title}</Text>
          <TextInput
            style={styles.modalInput}
            value={inputValue}
            onChangeText={setInputValue}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            secureTextEntry={secure}
            multiline={false}
            autoCapitalize="none"
          />
          <View style={styles.modalButtons}>
            <Pressable style={[styles.modalBtn, styles.modalBtnCancel]} onPress={onClose}>
              <Text style={styles.modalBtnText}>取消</Text>
            </Pressable>
            <Pressable style={[styles.modalBtn, styles.modalBtnSave]} onPress={() => onSave(inputValue)}>
              <Text style={[styles.modalBtnText, styles.modalBtnTextSave]}>保存</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function SettingsScreen({ onOpenSidebar }: SettingsScreenProps) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [editKey, setEditKey] = useState<keyof Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Array<{ id: string; name: string; path: string }>>([]);
  const [trustedProjects, setTrustedProjects] = useState<string[]>([]);
  const [auditLogs, setAuditLogs] = useState<Array<{ id: string; action: string; detail: string; risk_level: string; decision: string; created_at: string }>>([]);
  const [auditModalVisible, setAuditModalVisible] = useState(false);
  const [trustModalVisible, setTrustModalVisible] = useState(false);

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

  const updateSetting = async (key: keyof Settings, value: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, [key]: value }));
      }
    } catch (error) {
      console.error('Failed to update setting:', error);
      Alert.alert('错误', '保存设置失败');
    }
  };

  const handleToggle = (key: keyof Settings) => {
    const currentValue = settings[key] === 'true';
    updateSetting(key, (!currentValue).toString());
  };

  const handleShowCrashLogs = async () => {
    const logs = await getCrashLogs();
    if (logs.length === 0) {
      Alert.alert('崩溃日志', '暂无崩溃日志');
      return;
    }
    Alert.alert('崩溃日志', logs.join('\n\n---\n\n'), [
      { text: '清空', style: 'destructive', onPress: () => clearCrashLogs() },
      { text: '关闭', style: 'cancel' },
    ]);
  };

  const toggleTrust = async (projectId: string) => {
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
  };

  const fetchAuditLogs = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/audit?limit=50`);
      const data = await res.json();
      setAuditLogs(data.logs || []);
      setAuditModalVisible(true);
    } catch {
      Alert.alert('错误', '加载审计日志失败');
    }
  };

  const resetPermissions = () => {
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
  };

  const riskLabel = (level: string) =>
    ({ none: '无风险', medium: '中风险', high: '高风险', critical: '极高风险' }[level] || level);
  const decisionLabel = (decision: string) =>
    ({ auto: '自动放行', trusted: '可信项目', approved: '用户允许', denied: '用户拒绝', blocked: '策略拦截' }[decision] || decision);

  const handleClearCache = () => {
    Alert.alert('清除缓存', '确定要清除所有缓存数据吗？', [
      { text: '取消', style: 'cancel' },
      { text: '确定', style: 'destructive', onPress: () => Alert.alert('完成', '缓存已清除') },
    ]);
  };

  const maskValue = (value: string) => {
    if (!value) return '未配置';
    if (value.length <= 8) return '***';
    return value.slice(0, 4) + '...' + value.slice(-4);
  };

  if (loading) {
    return (
      <Screen backgroundColor={colors.bgRoot} statusBarStyle="light">
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

  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle="light">
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <MenuButton onPress={onOpenSidebar} />
          <Text style={styles.headerTitle}>设置</Text>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          {/* AI Model */}
          <Text style={styles.groupTitle}>AI 模型</Text>
          <View style={styles.group}>
            <Pressable style={styles.settingItem} onPress={() => setEditKey('ai_model')}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="robot" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>模型</Text>
              <Text style={styles.settingValue}>{settings.ai_model}</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
            <Pressable style={styles.settingItem} onPress={() => setEditKey('ai_api_key')}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="key" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>DeepSeek API Key</Text>
              <Text style={styles.settingValue}>{maskValue(settings.ai_api_key)}</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
            <Pressable style={styles.settingItem} onPress={() => setEditKey('ai_base_url')}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="server" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>服务地址</Text>
              <Text style={styles.settingValue} numberOfLines={1}>{settings.ai_base_url || 'DeepSeek 官方'}</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
            <Pressable style={styles.settingItem} onPress={() => setEditKey('ai_model_base_url')}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="code-branch" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>模型 API 地址</Text>
              <Text style={styles.settingValue} numberOfLines={1}>{settings.ai_model_base_url || 'DeepSeek 官方'}</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
          </View>

          {/* 语音识别 */}
          <Text style={styles.groupTitle}>语音识别</Text>
          <View style={styles.group}>
            <Pressable style={styles.settingItem} onPress={() => setEditKey('stt_api_key')}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="key" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>STT API Key</Text>
              <Text style={styles.settingValue}>{maskValue(settings.stt_api_key)}</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
            <Pressable style={styles.settingItem} onPress={() => setEditKey('stt_base_url')}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="server" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>STT 服务地址</Text>
              <Text style={styles.settingValue} numberOfLines={1}>{settings.stt_base_url || 'OpenAI 官方'}</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
            <Pressable style={styles.settingItem} onPress={() => setEditKey('stt_model')}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="microphone" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>STT 模型</Text>
              <Text style={styles.settingValue}>{settings.stt_model || 'whisper-1'}</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
          </View>

          {/* GitHub */}
          <Text style={styles.groupTitle}>GitHub</Text>
          <View style={styles.group}>
            <Pressable style={styles.settingItem} onPress={() => setEditKey('github_token')}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="github" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>Access Token</Text>
              <Text style={styles.settingValue}>{maskValue(settings.github_token)}</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
            <View style={styles.settingItem}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="arrow-rotate-right" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>自动推送</Text>
              <View style={{ flex: 1 }} />
              <Switch
                value={settings.github_auto_push === 'true'}
                onValueChange={() => handleToggle('github_auto_push')}
                trackColor={{ false: colors.bgElevated, true: colors.primaryGlow }}
                thumbColor={settings.github_auto_push === 'true' ? colors.primary : colors.textMuted}
              />
            </View>
          </View>

          {/* Development */}
          <Text style={styles.groupTitle}>开发环境</Text>
          <View style={styles.group}>
            <Pressable style={styles.settingItem} onPress={() => setEditKey('termux_path')}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="terminal" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>Termux 路径</Text>
              <Text style={styles.settingValue} numberOfLines={1}>{settings.termux_path}</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
            <Pressable style={styles.settingItem} onPress={() => setEditKey('build_method')}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="cloud" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>构建方式</Text>
              <Text style={styles.settingValue}>{settings.build_method === 'github_actions' ? 'GitHub Actions' : '本地构建'}</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
          </View>

          {/* 诊断 */}
          <Text style={styles.groupTitle}>诊断</Text>
          <View style={styles.group}>
            <Pressable style={styles.settingItem} onPress={handleShowCrashLogs}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="bug" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>崩溃日志</Text>
              <Text style={styles.settingValue}>查看</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
          </View>

          {/* Security */}
          <Text style={styles.groupTitle}>安全</Text>
          <View style={styles.group}>
            <View style={styles.settingItem}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="camera" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>工作区快照</Text>
              <View style={{ flex: 1 }} />
              <Switch
                value={settings.snapshot_enabled === 'true'}
                onValueChange={() => handleToggle('snapshot_enabled')}
                trackColor={{ false: colors.bgElevated, true: colors.primaryGlow }}
                thumbColor={settings.snapshot_enabled === 'true' ? colors.primary : colors.textMuted}
              />
            </View>
            <View style={styles.settingItem}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="eye" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>Diff 审查</Text>
              <View style={{ flex: 1 }} />
              <Switch
                value={settings.diff_review_enabled === 'true'}
                onValueChange={() => handleToggle('diff_review_enabled')}
                trackColor={{ false: colors.bgElevated, true: colors.primaryGlow }}
                thumbColor={settings.diff_review_enabled === 'true' ? colors.primary : colors.textMuted}
              />
            </View>
          </View>

          {/* Agent 权限 */}
          <Text style={styles.groupTitle}>Agent 权限</Text>
          <View style={styles.group}>
            <Pressable style={styles.settingItem} onPress={() => setTrustModalVisible(true)}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="shield" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>可信项目</Text>
              <Text style={styles.settingValue}>{trustedProjects.length} 个</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
            <Pressable style={styles.settingItem} onPress={fetchAuditLogs}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="scroll" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>操作审计日志</Text>
              <Text style={styles.settingValue}>查看</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
            <Pressable style={styles.settingItem} onPress={resetPermissions}>
              <View style={[styles.settingIcon, styles.settingIconDanger]}>
                <FontAwesome6 name="rotate-left" size={14} color={colors.error} />
              </View>
              <Text style={[styles.settingLabel, styles.settingLabelDanger]}>重置所有授权</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
          </View>

          {/* About */}
          <Text style={styles.groupTitle}>关于</Text>
          <View style={styles.group}>
            <View style={styles.settingItem}>
              <View style={styles.settingIcon}>
                <FontAwesome6 name="circle-info" size={14} color={colors.primary} />
              </View>
              <Text style={styles.settingLabel}>版本</Text>
              <Text style={styles.settingValue}>v1.0.0</Text>
            </View>
            <Pressable style={styles.settingItem} onPress={handleClearCache}>
              <View style={[styles.settingIcon, styles.settingIconDanger]}>
                <FontAwesome6 name="trash" size={14} color={colors.error} />
              </View>
              <Text style={[styles.settingLabel, styles.settingLabelDanger]}>清除缓存</Text>
              <FontAwesome6 name="chevron-right" size={10} color={colors.textMuted} />
            </Pressable>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>

        {/* Edit Modal */}
        <EditModal
          visible={editKey !== null}
          title={
            editKey === 'ai_model' ? '模型名称' :
            editKey === 'ai_api_key' ? 'API Key' :
            editKey === 'github_token' ? 'GitHub Token' :
            editKey === 'termux_path' ? 'Termux 路径' :
            editKey === 'build_method' ? '构建方式' : ''
          }
          value={editKey ? settings[editKey] : ''}
          placeholder={
            editKey === 'ai_api_key' ? 'sk-...' :
            editKey === 'github_token' ? 'ghp_...' :
            editKey === 'termux_path' ? '/data/data/com.termux' : ''
          }
          secure={editKey === 'ai_api_key' || editKey === 'github_token'}
          onClose={() => setEditKey(null)}
          onSave={(value) => {
            if (editKey) {
              updateSetting(editKey, value);
            }
            setEditKey(null);
          }}
        />

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
                    <Switch
                      value={trustedProjects.includes(project.id)}
                      onValueChange={() => toggleTrust(project.id)}
                      trackColor={{ false: colors.bgElevated, true: colors.primaryGlow }}
                      thumbColor={trustedProjects.includes(project.id) ? colors.primary : colors.textMuted}
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
      </View>
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
  groupTitle: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
    marginTop: spacing.lg,
    marginLeft: spacing.xs,
  },
  group: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  settingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md + 2,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.separator,
  },
  settingIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.sm + 2,
    backgroundColor: colors.primaryGlow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingIconDanger: {
    backgroundColor: 'rgba(239,68,68,0.1)',
  },
  settingLabel: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  settingLabelDanger: {
    color: colors.error,
  },
  settingValue: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginRight: spacing.sm,
    maxWidth: 120,
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
});
