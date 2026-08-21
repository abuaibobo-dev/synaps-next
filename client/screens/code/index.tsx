import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { showRoundedMessage } from '@/components/RoundedAlert';
import { MenuButton } from '@/components/Sidebar';

import { getApiBase } from '@/utils';
const API_BASE = getApiBase();
import { FontAwesome6 } from '@expo/vector-icons';
import { spacing, radius, fontSize } from '@/utils/theme';
import { getLanguageForPath, highlightLine } from '@/utils/syntaxHighlight';
import type { ThemeColors } from '@/utils/theme';
import { useThemeColors } from '@/components/ThemeProvider';


interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

interface SnapshotItem {
  id: string;
  project_id: string;
  label: string;
  file_count: number;
  created_at: string;
}

interface SnapshotFile {
  path: string;
  content: string;
}

interface CodeScreenProps {
  onOpenSidebar: () => void;
}

type ViewMode = 'files' | 'snapshots' | 'diff';

export default function CodeScreen({ onOpenSidebar }: CodeScreenProps) {
  const { colors, isDark } = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLanguage, setFileLanguage] = useState('plaintext');
  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ path: string; name: string; type: string; match?: string }>>([]);
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  
  // Diff review state
  const [viewMode, setViewMode] = useState<ViewMode>('files');
  const [snapshots, setSnapshots] = useState<SnapshotItem[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState<SnapshotItem | null>(null);
  const [snapshotFiles, setSnapshotFiles] = useState<SnapshotFile[]>([]);
  const [diffFile, setDiffFile] = useState<SnapshotFile | null>(null);

  const fetchFiles = useCallback(async (dirPath: string = '') => {
    if (!projectId) return;
    setLoading(true);
    try {
      /**
       * 服务端文件：server/src/routes/files.ts
       * 接口：GET /api/v1/files/list
       * Query 参数：projectId: string, path?: string
       */
      const response = await fetch(
        `${API_BASE}/api/v1/files/list?projectId=${projectId}&path=${encodeURIComponent(dirPath)}`
      );
      const data = await response.json();
      if (data.files) {
        setFiles(data.files);
        setCurrentPath(dirPath);
      }
    } catch (err) {
      console.error('Failed to fetch files:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const readFile = useCallback(async (filePath: string) => {
    if (!projectId) return;
    setLoading(true);
    try {
      /**
       * 服务端文件：server/src/routes/files.ts
       * 接口：GET /api/v1/files/read
       * Query 参数：projectId: string, path: string
       */
      const response = await fetch(
        `${API_BASE}/api/v1/files/read?projectId=${projectId}&path=${encodeURIComponent(filePath)}`
      );
      const data = await response.json();
      if (data.content !== undefined) {
        setFileContent(data.content);
        setDraftContent(data.content);
        setSelectedFile(filePath);
        setFileLanguage(getLanguageForPath(filePath));
        setEditing(false);
        setSaveState('saved');
      }
    } catch (err) {
      console.error('Failed to read file:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const saveFile = useCallback(async () => {
    if (!projectId || !selectedFile) return;
    setSaveState('saving');
    try {
      const response = await fetch(`${API_BASE}/api/v1/files/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, path: selectedFile, content: draftContent }),
      });
      const data = await response.json();
      if (data.success) {
        setFileContent(draftContent);
        setSaveState('saved');
        setEditing(false);
        fetchFiles(currentPath);
      } else {
        setSaveState('dirty');
        showRoundedMessage(data.error || '保存失败');
      }
    } catch (err) {
      setSaveState('dirty');
      showRoundedMessage('保存失败：' + String(err));
    }
  }, [projectId, selectedFile, draftContent, currentPath, fetchFiles]);

  const searchFiles = useCallback(async () => {
    if (!projectId || !searchQuery.trim()) return;
    setLoading(true);
    try {
      /**
       * 服务端文件：server/src/routes/files.ts
       * 接口：GET /api/v1/files/search
       * Query 参数：projectId: string, query: string, searchIn?: string
       */
      const response = await fetch(
        `${API_BASE}/api/v1/files/search?projectId=${projectId}&query=${encodeURIComponent(searchQuery)}&searchIn=both`
      );
      const data = await response.json();
      setSearchResults(data.results || []);
    } catch (err) {
      console.error('Failed to search files:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId, searchQuery]);

  const fetchSnapshots = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      /**
       * 服务端文件：server/src/routes/snapshots.ts
       * 接口：GET /api/v1/snapshots/list
       * Query 参数：projectId: string
       */
      const response = await fetch(
        `${API_BASE}/api/v1/snapshots/list?projectId=${projectId}`
      );
      const data = await response.json();
      setSnapshots(data.snapshots || []);
    } catch (err) {
      console.error('Failed to fetch snapshots:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const fetchSnapshotDetail = useCallback(async (snapshotId: string) => {
    setLoading(true);
    try {
      /**
       * 服务端文件：server/src/routes/snapshots.ts
       * 接口：GET /api/v1/snapshots/:id
       * Path 参数：id: string
       */
      const response = await fetch(
        `${API_BASE}/api/v1/snapshots/${snapshotId}`
      );
      const data = await response.json();
      setSnapshotFiles(data.files || []);
    } catch (err) {
      console.error('Failed to fetch snapshot detail:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const restoreSnapshot = useCallback(async (snapshotId: string) => {
    setLoading(true);
    try {
      /**
       * 服务端文件：server/src/routes/snapshots.ts
       * 接口：POST /api/v1/snapshots/:id/restore
       * Path 参数：id: string
       */
      const response = await fetch(
        `${API_BASE}/api/v1/snapshots/${snapshotId}/restore`,
        { method: 'POST' }
      );
      const data = await response.json();
      if (data.success) {
        showRoundedMessage('快照已恢复');
        setViewMode('files');
        fetchFiles('');
      }
    } catch (err) {
      console.error('Failed to restore snapshot:', err);
      showRoundedMessage('恢复失败');
    } finally {
      setLoading(false);
    }
  }, [fetchFiles]);

  const navigateToDir = (dirPath: string) => {
    setPathHistory(prev => [...prev, currentPath]);
    fetchFiles(dirPath);
  };

  const goBack = () => {
    if (pathHistory.length > 0) {
      const prevPath = pathHistory[pathHistory.length - 1];
      setPathHistory(h => h.slice(0, -1));
      fetchFiles(prevPath);
    }
  };

  const handleFilePress = (file: FileEntry) => {
    if (file.type === 'directory') {
      navigateToDir(file.path);
    } else {
      readFile(file.path);
    }
  };

  const handleProjectSelect = (id: string) => {
    setProjectId(id);
    setCurrentPath('');
    setSelectedFile(null);
    setFileContent('');
    fetchFiles('');
  };

  const handleSnapshotPress = (snapshot: SnapshotItem) => {
    setSelectedSnapshot(snapshot);
    fetchSnapshotDetail(snapshot.id);
    setViewMode('diff');
  };

  // Demo project for testing
  const demoProjectId = 'demo-project';

  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle={isDark ? 'light' : 'dark'} scrollable>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <MenuButton onPress={onOpenSidebar} />
          <Text style={styles.headerTitle}>
            {viewMode === 'snapshots' ? '快照' : viewMode === 'diff' ? 'Diff 审查' : '代码'}
          </Text>
          <View style={styles.headerActions}>
            <Pressable
              style={[styles.headerBtn, viewMode === 'files' && styles.headerBtnActive]}
              onPress={() => { setViewMode('files'); if (projectId) fetchFiles(''); }}
            >
              <FontAwesome6 name="folder" size={12} color={viewMode === 'files' ? colors.primary : colors.textSecondary} />
            </Pressable>
            <Pressable
              style={[styles.headerBtn, viewMode === 'snapshots' && styles.headerBtnActive]}
              onPress={() => { setViewMode('snapshots'); if (projectId) fetchSnapshots(); }}
            >
              <FontAwesome6 name="clock-rotate-left" size={12} color={viewMode === 'snapshots' ? colors.primary : colors.textSecondary} />
            </Pressable>
            <Pressable
              style={styles.headerBtn}
              onPress={() => setShowSearch(!showSearch)}
            >
              <FontAwesome6
                name="magnifying-glass"
                size={12}
                color={showSearch ? colors.primary : colors.textSecondary}
              />
            </Pressable>
          </View>
        </View>

        {/* Search Bar */}
        {showSearch && viewMode === 'files' && (
          <View style={styles.searchBar}>
            <TextInput
              style={styles.searchInput}
              placeholder="搜索文件名或内容..."
              placeholderTextColor={colors.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onSubmitEditing={searchFiles}
              returnKeyType="search"
            />
            <Pressable style={styles.searchBtn} onPress={searchFiles}>
              <FontAwesome6 name="magnifying-glass" size={14} color={colors.primary} />
            </Pressable>
          </View>
        )}

        {/* Project Selector (if no project selected) */}
        {!projectId && (
          <View style={styles.content}>
            <View style={styles.emptyState}>
              <View style={styles.emptyIcon}>
                <FontAwesome6 name="folder-open" size={28} color={colors.textMuted} />
              </View>
              <Text style={styles.emptyText}>未选择项目</Text>
              <Text style={styles.emptyHint}>先在「项目」模块中打开一个项目</Text>
              <Pressable
                style={styles.demoBtn}
                onPress={() => handleProjectSelect(demoProjectId)}
              >
                <Text style={styles.demoBtnText}>加载演示项目</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* File Browser */}
        {projectId && viewMode === 'files' && !selectedFile && !showSearch && (
          <View style={styles.content}>
            {/* Path breadcrumb */}
            <View style={styles.breadcrumb}>
              <Pressable onPress={() => fetchFiles('')} style={styles.breadcrumbItem}>
                <FontAwesome6 name="house" size={12} color={colors.primary} />
                <Text style={styles.breadcrumbText}>/</Text>
              </Pressable>
              {currentPath.split('/').filter(Boolean).map((segment, i, arr) => (
                <React.Fragment key={i}>
                  <Text style={styles.breadcrumbSep}>/</Text>
                  <Pressable
                    onPress={() => {
                      const targetPath = arr.slice(0, i + 1).join('/');
                      navigateToDir(targetPath);
                    }}
                    style={styles.breadcrumbItem}
                  >
                    <Text style={[
                      styles.breadcrumbText,
                      i === arr.length - 1 && styles.breadcrumbActive,
                    ]}>
                      {segment}
                    </Text>
                  </Pressable>
                </React.Fragment>
              ))}
              {pathHistory.length > 0 && (
                <Pressable onPress={goBack} style={styles.backBtn}>
                  <FontAwesome6 name="arrow-left" size={12} color={colors.textSecondary} />
                </Pressable>
              )}
            </View>

            {loading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : (
              <ScrollView style={styles.fileList}>
                {files.length === 0 ? (
                  <View style={styles.emptyDir}>
                    <FontAwesome6 name="file-circle-plus" size={22} color={colors.textMuted} />
                    <Text style={styles.emptyDirText}>当前项目为空，请创建文件</Text>
                  </View>
                ) : (
                  files.map((file) => (
                    <Pressable
                      key={file.path}
                      style={styles.fileItem}
                      onPress={() => handleFilePress(file)}
                    >
                      <FontAwesome6
                        name={file.type === 'directory' ? 'folder' : getFileIcon(file.name)}
                        size={14}
                        color={file.type === 'directory' ? colors.primary : colors.textSecondary}
                      />
                      <Text style={[
                        styles.fileName,
                        file.type === 'directory' && styles.dirName,
                      ]}>
                        {file.name}
                      </Text>
                      {file.type === 'file' && (
                        <Text style={styles.fileSize}>
                          {formatFileSize(file.size)}
                        </Text>
                      )}
                    </Pressable>
                  ))
                )}
              </ScrollView>
            )}
          </View>
        )}

        {/* Snapshots List */}
        {projectId && viewMode === 'snapshots' && (
          <View style={styles.content}>
            {loading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : (
              <ScrollView style={styles.fileList}>
                {snapshots.length === 0 ? (
                  <View style={styles.emptyDir}>
                    <FontAwesome6 name="clock-rotate-left" size={24} color={colors.textMuted} />
                    <Text style={styles.emptyDirText}>暂无快照</Text>
                    <Text style={styles.emptyHint}>Agent 修改文件时会自动创建快照</Text>
                  </View>
                ) : (
                  snapshots.map((snapshot) => (
                    <Pressable
                      key={snapshot.id}
                      style={styles.snapshotItem}
                      onPress={() => handleSnapshotPress(snapshot)}
                    >
                      <View style={styles.snapshotIcon}>
                        <FontAwesome6 name="clock-rotate-left" size={14} color={colors.primary} />
                      </View>
                      <View style={styles.snapshotInfo}>
                        <Text style={styles.snapshotLabel}>{snapshot.label || '未命名快照'}</Text>
                        <Text style={styles.snapshotMeta}>
                          {snapshot.file_count} 个文件 · {new Date(snapshot.created_at).toLocaleString()}
                        </Text>
                      </View>
                      <FontAwesome6 name="chevron-right" size={12} color={colors.textMuted} />
                    </Pressable>
                  ))
                )}
              </ScrollView>
            )}
          </View>
        )}

        {/* Diff Review */}
        {projectId && viewMode === 'diff' && selectedSnapshot && (
          <View style={styles.content}>
            {/* Snapshot header */}
            <View style={styles.diffHeader}>
              <Pressable
                style={styles.diffBackBtn}
                onPress={() => { setViewMode('snapshots'); setSelectedSnapshot(null); setSnapshotFiles([]); }}
              >
                <FontAwesome6 name="arrow-left" size={14} color={colors.textSecondary} />
                <Text style={styles.diffBackText}>返回</Text>
              </Pressable>
              <Pressable
                style={styles.restoreBtn}
                onPress={() => restoreSnapshot(selectedSnapshot.id)}
              >
                <FontAwesome6 name="rotate-left" size={12} color={colors.primary} />
                <Text style={styles.restoreBtnText}>恢复此快照</Text>
              </Pressable>
            </View>

            {/* Snapshot info */}
            <View style={styles.snapshotDetailHeader}>
              <Text style={styles.snapshotDetailLabel}>{selectedSnapshot.label || '未命名快照'}</Text>
              <Text style={styles.snapshotDetailMeta}>
                {new Date(selectedSnapshot.created_at).toLocaleString()} · {selectedSnapshot.file_count} 个文件
              </Text>
            </View>

            {/* Files in snapshot */}
            {loading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : (
              <ScrollView style={styles.fileList}>
                {snapshotFiles.map((file, i) => (
                  <Pressable
                    key={i}
                    style={styles.fileItem}
                    onPress={() => setDiffFile(file)}
                  >
                    <FontAwesome6 name="file-code" size={14} color={colors.textSecondary} />
                    <Text style={styles.fileName}>{file.path}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        )}

        {/* Diff File Viewer */}
        {projectId && viewMode === 'diff' && diffFile && (
          <View style={styles.content}>
            <View style={styles.diffHeader}>
              <Pressable
                style={styles.diffBackBtn}
                onPress={() => setDiffFile(null)}
              >
                <FontAwesome6 name="arrow-left" size={14} color={colors.textSecondary} />
                <Text style={styles.diffBackText}>返回</Text>
              </Pressable>
              <View style={styles.fileBadge}>
                <Text style={styles.fileBadgeText}>快照内容</Text>
              </View>
            </View>

            <View style={styles.codeViewer}>
              <ScrollView horizontal showsHorizontalScrollIndicator={true}>
                <View style={styles.codeContent}>
                  {diffFile.content.split('\n').map((line, i) => (
                    <View key={i} style={styles.codeLine}>
                      <Text style={styles.lineNumber}>{i + 1}</Text>
                      <Text style={styles.lineContent} selectable>
                        {line || ' '}
                      </Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
            </View>
          </View>
        )}

        {/* Search Results */}
        {projectId && viewMode === 'files' && showSearch && searchResults.length > 0 && (
          <ScrollView style={styles.content}>
            {searchResults.map((result, i) => (
              <Pressable
                key={i}
                style={styles.searchResult}
                onPress={() => {
                  if (result.type === 'file') {
                    readFile(result.path);
                    setShowSearch(false);
                  }
                }}
              >
                <FontAwesome6
                  name={result.type === 'directory' ? 'folder' : 'file-code'}
                  size={12}
                  color={colors.textSecondary}
                />
                <View style={styles.searchResultInfo}>
                  <Text style={styles.searchResultPath}>{result.path}</Text>
                  {result.match && (
                    <Text style={styles.searchResultMatch} numberOfLines={1}>
                      {result.match}
                    </Text>
                  )}
                </View>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {/* File Viewer */}
        {projectId && viewMode === 'files' && selectedFile && (
          <View style={styles.content}>
            {/* File header */}
            <View style={styles.fileHeader}>
              <Pressable
                style={styles.fileBackBtn}
                onPress={() => {
                  setSelectedFile(null);
                  setFileContent('');
                }}
              >
                <FontAwesome6 name="arrow-left" size={14} color={colors.textSecondary} />
                <Text style={styles.fileBackText}>返回</Text>
              </Pressable>
              <View style={styles.fileBadge}>
                <Text style={styles.fileBadgeText}>{fileLanguage}</Text>
              </View>
              <View style={styles.fileSaveArea}>
                <Text style={[
                  styles.saveStateText,
                  saveState === 'dirty' && styles.saveStateDirty,
                  saveState === 'saving' && styles.saveStateSaving,
                ]}>
                  {saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中...' : '未保存'}
                </Text>
                {editing ? (
                  <Pressable
                    style={styles.saveBtn}
                    onPress={() => {
                      if (saveState === 'dirty' || saveState === 'saving') saveFile();
                      else setEditing(false);
                    }}
                  >
                    <FontAwesome6 name={saveState === 'saved' ? 'xmark' : 'floppy-disk'} size={11} color="#FFFFFF" />
                    <Text style={styles.saveBtnText}>{saveState === 'saved' ? '退出编辑' : '保存'}</Text>
                  </Pressable>
                ) : (
                  <Pressable style={styles.editBtn} onPress={() => { setEditing(true); setDraftContent(fileContent); }}>
                    <FontAwesome6 name="pen" size={11} color={colors.primary} />
                    <Text style={styles.editBtnText}>编辑</Text>
                  </Pressable>
                )}
              </View>
            </View>

            {/* Code content: 编辑模式 */}
            {editing ? (
              <TextInput
                style={[styles.codeEditor, { color: colors.textPrimary }]}
                value={draftContent}
                onChangeText={(t) => {
                  setDraftContent(t);
                  setSaveState('dirty');
                }}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                textAlignVertical="top"
              />
            ) : (
              <View style={styles.codeViewer}>
                <ScrollView horizontal showsHorizontalScrollIndicator={true}>
                  <View style={styles.codeContent}>
                    {fileContent.split('\n').map((line, i) => (
                      <View key={i} style={styles.codeLine}>
                        <Text style={styles.lineNumber}>{i + 1}</Text>
                        <HighlightedLine line={line} lang={fileLanguage} colors={colors} isDark={isDark} />
                      </View>
                    ))}
                  </View>
                </ScrollView>
              </View>
            )}
          </View>
        )}
      </View>
    </Screen>
  );
}

function HighlightedLine({ line, lang, colors, isDark }: {
  line: string;
  lang: string;
  colors: ThemeColors;
  isDark: boolean;
}) {
  const segments = useMemo(() => highlightLine(line, lang), [line, lang]);
  const tokenColors: Record<string, string> = {
    plain: '#E4E4E7',
    comment: '#6B7280',
    string: '#86EFAC',
    keyword: colors.primary,
    number: '#FDBA74',
    type: '#67E8F9',
    function: '#93C5FD',
  };
  return (
    <Text
      style={{
        flex: 1,
        color: '#E4E4E7',
        fontSize: fontSize.xs,
        fontFamily: 'JetBrainsMono',
      }}
      selectable
    >
      {segments.map((seg, i) => (
        <Text key={i} style={{ color: tokenColors[seg.token] || colors.textPrimary }}>
          {seg.text || ' '}
        </Text>
      ))}
    </Text>
  );
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const iconMap: Record<string, string> = {
    ts: 'js-file',
    tsx: 'js-file',
    js: 'js-file',
    jsx: 'js-file',
    json: 'file-code',
    html: 'html5',
    css: 'css3',
    md: 'file-lines',
    py: 'python',
    java: 'java',
    kt: 'android',
    xml: 'file-code',
    gradle: 'gear',
    sh: 'terminal',
    yml: 'file-code',
    yaml: 'file-code',
    sql: 'database',
  };
  return iconMap[ext] || 'file';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: 52,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.textPrimary,
    fontFamily: 'JetBrainsMono',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 6,
  },
  headerBtn: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    backgroundColor: colors.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerBtnActive: {
    backgroundColor: colors.primary + '20',
    borderWidth: 1,
    borderColor: colors.primary + '40',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  searchInput: {
    flex: 1,
    height: 36,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontFamily: 'JetBrainsMono',
  },
  searchBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyText: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  emptyHint: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textAlign: 'center',
  },
  demoBtn: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  demoBtnText: {
    color: '#000',
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  breadcrumb: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgElevated,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexWrap: 'wrap',
  },
  breadcrumbItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  breadcrumbSep: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginHorizontal: 4,
  },
  breadcrumbText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontFamily: 'JetBrainsMono',
    marginLeft: 4,
  },
  breadcrumbActive: {
    color: colors.primary,
    fontWeight: '600',
  },
  backBtn: {
    marginLeft: 'auto',
    padding: 4,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  fileList: {
    flex: 1,
  },
  fileItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  fileName: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontFamily: 'JetBrainsMono',
  },
  dirName: {
    fontWeight: '600',
    color: colors.primary,
  },
  fileSize: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    fontFamily: 'JetBrainsMono',
  },
  emptyDir: {
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
  },
  emptyDirText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  // Snapshot styles
  snapshotItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  snapshotIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.primary + '15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  snapshotInfo: {
    flex: 1,
  },
  snapshotLabel: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  snapshotMeta: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: 2,
  },
  // Diff styles
  diffHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  diffBackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  diffBackText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  restoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.primary + '20',
  },
  restoreBtnText: {
    color: colors.primary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  snapshotDetailHeader: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  snapshotDetailLabel: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  snapshotDetailMeta: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: 2,
  },
  searchResult: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  searchResultInfo: {
    flex: 1,
  },
  searchResultPath: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontFamily: 'JetBrainsMono',
  },
  searchResultMatch: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontFamily: 'JetBrainsMono',
    marginTop: 2,
  },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  fileBackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  fileBackText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  fileBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.primary + '20',
  },
  fileBadgeText: {
    color: colors.primary,
    fontSize: fontSize.xs,
    fontFamily: 'JetBrainsMono',
    fontWeight: '600',
  },
  codeViewer: {
    flex: 1,
    backgroundColor: '#0D0D14',
  },
  codeContent: {
    minWidth: '100%',
  },
  codeLine: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    minHeight: 20,
  },
  lineNumber: {
    width: 40,
    color: '#6B7280',
    fontSize: fontSize.xs,
    fontFamily: 'JetBrainsMono',
    textAlign: 'right',
    marginRight: spacing.sm,
  },
  lineContent: {
    flex: 1,
    color: '#E4E4E7',
    fontSize: fontSize.xs,
    fontFamily: 'JetBrainsMono',
  },
  codeEditor: {
    flex: 1,
    backgroundColor: '#0D0D14',
    color: '#E4E4E7',
    fontSize: fontSize.xs,
    fontFamily: 'JetBrainsMono',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 300,
  },
  fileSaveArea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginLeft: 'auto',
  },
  saveStateText: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    fontWeight: '600',
  },
  saveStateDirty: {
    color: '#F59E0B',
  },
  saveStateSaving: {
    color: colors.primary,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.sm,
  },
  saveBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.primaryGlow,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.sm,
  },
  editBtnText: {
    color: colors.primary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
});
