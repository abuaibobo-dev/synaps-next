import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, TextInput, Modal, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { Screen } from '@/components/Screen';
import { MenuButton } from '@/components/Sidebar';

import { getApiBase } from '@/utils';
const API_BASE = getApiBase();
import { FontAwesome6 } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';
import { useThemeColors } from '@/components/ThemeProvider';


interface Project {
  id: string;
  name: string;
  path: string;
  description: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
}

interface ProjectItemProps {
  project: Project;
  onPress: (project: Project) => void;
  onDelete: (project: Project) => void;
}

function ProjectItem({ project, onPress, onDelete }: ProjectItemProps) {
  const { colors } = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const timeAgo = project.last_opened_at
    ? formatTimeAgo(project.last_opened_at)
    : formatTimeAgo(project.created_at);

  return (
    <Pressable style={styles.projectCard} onPress={() => onPress(project)}>
      <View style={styles.projectHeader}>
        <View style={styles.projectIcon}>
          <FontAwesome6 name="folder" size={16} color={colors.primary} />
        </View>
        <View style={styles.projectInfo}>
          <Text style={styles.projectName}>{project.name}</Text>
          <Text style={styles.projectPath} numberOfLines={1}>{project.path}</Text>
        </View>
        <Pressable
          style={styles.deleteButton}
          onPress={() => onDelete(project)}
          hitSlop={8}
        >
          <FontAwesome6 name="trash-can" size={12} color={colors.danger} />
        </Pressable>
      </View>
      {project.description ? (
        <Text style={styles.projectDesc} numberOfLines={2}>{project.description}</Text>
      ) : null}
      <Text style={styles.projectTime}>{timeAgo}</Text>
    </Pressable>
  );
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr + 'Z');
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return date.toLocaleDateString();
}

interface ProjectsScreenProps {
  onOpenSidebar: () => void;
}

export default function ProjectsScreen({ onOpenSidebar }: ProjectsScreenProps) {
  const { colors, isDark } = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [formName, setFormName] = useState('');
  const [formPath, setFormPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [formDesc, setFormDesc] = useState('');
  const [formTemplate, setFormTemplate] = useState('blank');
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; icon: string; description: string }>>([]);
  const [loading, setLoading] = useState(false);

  const fetchProjects = useCallback(async () => {
    try {
      const url = searchQuery.trim()
        ? `${API_BASE}/api/v1/projects?search=${encodeURIComponent(searchQuery.trim())}`
        : `${API_BASE}/api/v1/projects`;
      const response = await fetch(url);
      const data = await response.json();
      setProjects(data.projects || []);
    } catch {
      // Silently fail, keep existing data
    }
  }, [searchQuery]);

  const fetchTemplates = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/templates`);
      const data = await response.json();
      setTemplates(data.templates || []);
    } catch {
      // 模板获取失败时静默，默认空白模板
    }
  }, []);

  const fetchDefaultPath = useCallback(async (name: string) => {
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/default-path?name=${encodeURIComponent(name)}`);
      if (!response.ok) return;
      const data = await response.json();
      if (data && typeof data.path === 'string' && data.path.trim()) {
        setFormPath(data.path);
      }
    } catch {
      // 后端未就绪时保持原样
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchProjects();
      fetchTemplates();
    }, [fetchProjects, fetchTemplates])
  );

  const handleAdd = () => {
    setEditingProject(null);
    setFormName('');
    setFormPath('');
    setPathTouched(false);
    setFormDesc('');
    setFormTemplate('blank');
    setModalVisible(true);
  };

  const handleEdit = (project: Project) => {
    setEditingProject(project);
    setFormName(project.name);
    setFormPath(project.path);
    setPathTouched(true);
    setFormDesc(project.description);
    setModalVisible(true);
  };

  const handleDelete = (project: Project) => {
    Alert.alert(
      '删除项目',
      `确定要删除「${project.name}」吗？\n此操作不会删除实际文件。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            try {
              /**
               * 服务端文件：server/src/routes/projects.ts
               * 接口：DELETE /api/v1/projects/:id
               * Path 参数：id: string
               */
              await fetch(`${API_BASE}/api/v1/projects/${project.id}`, {
                method: 'DELETE',
              });
              fetchProjects();
            } catch {
              // Silently fail
            }
          },
        },
      ]
    );
  };

  const handleSave = async () => {
    if (!formName.trim() || !formPath.trim()) return;

    setLoading(true);
    try {
      const url = editingProject
        ? `${API_BASE}/api/v1/projects/${editingProject.id}`
        : `${API_BASE}/api/v1/projects`;
      const method = editingProject ? 'PUT' : 'POST';
      /**
       * 服务端文件：server/src/routes/projects.ts
       * 接口：POST /api/v1/projects（新建）/ PUT /api/v1/projects/:id（编辑）
       * Body 参数：name: string, path: string, description?: string, template?: string
       */
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          path: formPath.trim(),
          description: formDesc.trim(),
          ...(editingProject ? {} : { template: formTemplate }),
        }),
      });
      if (!res.ok) {
        let msg = `请求失败（${res.status}）`;
        try {
          const data = await res.json();
          if (data && data.error) msg = String(data.error);
        } catch {
          // 保留默认错误信息
        }
        Alert.alert('保存失败', msg);
        return;
      }
      setModalVisible(false);
      fetchProjects();
    } catch {
      Alert.alert('保存失败', '无法连接后端，请确认 App 后端服务已启动');
    } finally {
      setLoading(false);
    }
  };
;

  const handleProjectPress = async (project: Project) => {
    // Open project - update last opened
    try {
      /**
       * 服务端文件：server/src/routes/projects.ts
       * 接口：GET /api/v1/projects/:id
       * Path 参数：id: string
       */
      await fetch(`${API_BASE}/api/v1/projects/${project.id}`);
    } catch {
      // Silently fail
    }
    // Navigate to agent with this project
    handleEdit(project);
  };

  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle={isDark ? 'light' : 'dark'} scrollable>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <MenuButton onPress={onOpenSidebar} />
          <Text style={styles.headerTitle}>项目</Text>
          <Pressable style={styles.addButton} onPress={handleAdd}>
            <FontAwesome6 name="plus" size={14} color={colors.primary} />
          </Pressable>
        </View>

        {/* Search */}
        <View style={styles.searchBar}>
          <FontAwesome6 name="magnifying-glass" size={14} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="搜索项目..."
            placeholderTextColor={colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery('')}>
              <FontAwesome6 name="xmark" size={14} color={colors.textMuted} />
            </Pressable>
          )}
        </View>

        {/* Project List */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            {searchQuery ? '搜索结果' : '全部项目'}
          </Text>
          {projects.length === 0 ? (
            <View style={styles.emptyState}>
              <View style={styles.emptyIcon}>
                <FontAwesome6 name="folder-open" size={32} color={colors.textMuted} />
              </View>
              <Text style={styles.emptyText}>
                {searchQuery ? '未找到匹配的项目' : '暂无项目'}
              </Text>
              <Text style={styles.emptyHint}>
                {searchQuery ? '尝试其他关键词' : '点击右上角 + 创建或导入项目'}
              </Text>
            </View>
          ) : (
            <FlatList
              data={projects}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <ProjectItem
                  project={item}
                  onPress={handleProjectPress}
                  onDelete={handleDelete}
                />
              )}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>

        {/* Create/Edit Modal */}
        <Modal visible={modalVisible} transparent animationType="slide">
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={styles.modalOverlay}>
              <View style={styles.modalContent}>
                {/* Modal Header */}
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>
                    {editingProject ? '编辑项目' : '新建项目'}
                  </Text>
                  <Pressable onPress={() => setModalVisible(false)}>
                    <FontAwesome6 name="xmark" size={18} color={colors.textMuted} />
                  </Pressable>
                </View>

                {/* Form */}
                <View style={styles.modalBody}>
                  <Text style={styles.label}>项目名称</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="例如：MyApp"
                    placeholderTextColor={colors.textMuted}
                    value={formName}
                    onChangeText={(v) => {
                      setFormName(v);
                      if (!pathTouched && v.trim()) fetchDefaultPath(v.trim());
                    }}
                    autoCapitalize="none"
                  />

                  <Text style={styles.label}>项目路径</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="自动生成，也可手动填写"
                    placeholderTextColor={colors.textMuted}
                    value={formPath}
                    onChangeText={(v) => {
                      setFormPath(v);
                      setPathTouched(true);
                    }}
                    autoCapitalize="none"
                  />
                  <View style={styles.pathHintRow}>
                    <Text style={styles.pathHint}>输入项目名称后路径会自动生成，也可点右侧「自动」重新生成</Text>
                    <Pressable
                      style={styles.pathAutoBtn}
                      onPress={() => {
                        if (!formName.trim()) return;
                        setPathTouched(false);
                        fetchDefaultPath(formName.trim());
                      }}
                    >
                      <Text style={styles.pathAutoBtnText}>自动</Text>
                    </Pressable>
                  </View>

                  {!editingProject && (
                    <>
                      <Text style={styles.label}>项目模板</Text>
                      <View style={styles.templateRow}>
                        {templates.map((t) => (
                          <Pressable
                            key={t.id}
                            style={[styles.templateChip, formTemplate === t.id && styles.templateChipActive]}
                            onPress={() => setFormTemplate(t.id)}
                          >
                            <Text style={[styles.templateChipText, formTemplate === t.id && styles.templateChipTextActive]}>
                              {t.name}
                            </Text>
                          </Pressable>
                        ))}
                        {templates.length === 0 && (
                          <Text style={styles.templateHint}>模板加载中...</Text>
                        )}
                      </View>
                      {formTemplate !== 'blank' && (
                        <Text style={styles.templateHint}>
                          {templates.find((t) => t.id === formTemplate)?.description || '将在项目路径下生成基础骨架文件'}
                        </Text>
                      )}
                    </>
                  )}

                  <Text style={styles.label}>描述（可选）</Text>
                  <TextInput
                    style={[styles.input, styles.textArea]}
                    placeholder="项目描述..."
                    placeholderTextColor={colors.textMuted}
                    value={formDesc}
                    onChangeText={setFormDesc}
                    multiline
                    numberOfLines={3}
                    autoCapitalize="none"
                  />
                </View>

                {/* Modal Footer */}
                <View style={styles.modalFooter}>
                  <Pressable
                    style={[styles.modalBtn, styles.cancelBtn]}
                    onPress={() => setModalVisible(false)}
                  >
                    <Text style={styles.cancelBtnText}>取消</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.modalBtn,
                      styles.saveBtn,
                      (!formName.trim() || !formPath.trim() || loading) && styles.saveBtnDisabled,
                    ]}
                    onPress={handleSave}
                    disabled={!formName.trim() || !formPath.trim() || loading}
                  >
                    <Text style={styles.saveBtnText}>
                      {loading ? '保存中...' : '保存'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    </Screen>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
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
  addButton: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.primaryGlow,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  searchInput: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    paddingVertical: spacing.xs,
  },
  section: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },
  listContent: {
    paddingBottom: spacing.xl,
  },
  projectCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  projectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  projectIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.primaryGlow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectInfo: {
    flex: 1,
  },
  projectName: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  projectPath: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: 2,
  },
  projectDesc: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    lineHeight: 18,
  },
  projectTime: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
  deleteButton: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: spacing.xxl * 2,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyText: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  emptyHint: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: colors.bgCard,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: {
    fontSize: fontSize.lg,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  modalBody: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: fontSize.md,
    color: colors.textPrimary,
  },
  textArea: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  pathHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 2,
  },
  pathHint: {
    flex: 1,
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  pathAutoBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  pathAutoBtnText: {
    fontSize: fontSize.xs,
    color: '#FFFFFF',
    fontWeight: '600',
  },

  modalFooter: {
    flexDirection: 'row',
    padding: spacing.lg,
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  cancelBtn: {
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelBtnText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    fontWeight: '500',
  },
  saveBtn: {
    backgroundColor: colors.primary,
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  templateRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  templateChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  templateChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryGlow,
  },
  templateChipText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  templateChipTextActive: {
    color: colors.primary,
  },
  templateHint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginBottom: spacing.xs,
    lineHeight: 15,
  },
});
