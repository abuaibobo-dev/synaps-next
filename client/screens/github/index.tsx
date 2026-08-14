import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, TextInput, ActivityIndicator } from 'react-native';
import { Screen } from '@/components/Screen';
import { MenuButton } from '@/components/Sidebar';

import { getApiBase } from '@/utils';
const API_BASE = getApiBase();
import { FontAwesome6 } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';
import { useThemeColors } from '@/components/ThemeProvider';


interface Repository {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
  default_branch: string;
  language: string | null;
  stars?: number;
  forks?: number;
  updated_at: string;
  size: number;
}

interface GithubScreenProps {
  onOpenSidebar: () => void;
}

export default function GithubScreen({ onOpenSidebar }: GithubScreenProps) {
  const { colors, isDark } = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [viewMode, setViewMode] = useState<'my' | 'search'>('my');

  const fetchRepos = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/v1/github/repos`);
      if (response.ok) {
        const data = await response.json();
        setRepos(data.repos || []);
        setTokenConfigured(true);
      } else if (response.status === 401) {
        setTokenConfigured(false);
      }
    } catch (error) {
      console.error('Error fetching repos:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const searchRepos = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/github/search?q=${encodeURIComponent(searchQuery)}`
      );
      if (response.ok) {
        const data = await response.json();
        setRepos(data.repos || []);
        setTokenConfigured(true);
      }
    } catch (error) {
      console.error('Error searching repos:', error);
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  useFocusEffect(
    useCallback(() => {
      fetchRepos();
    }, [fetchRepos])
  );

  const renderRepo = ({ item }: { item: Repository }) => (
    <View style={styles.repoCard}>
      <View style={styles.repoHeader}>
        <View style={styles.repoNameRow}>
          <FontAwesome6 name={item.private ? 'lock' : 'globe'} size={12} color={colors.textMuted} />
          <Text style={styles.repoName} numberOfLines={1}>{item.name}</Text>
        </View>
        {item.language && (
          <View style={styles.langBadge}>
            <Text style={styles.langText}>{item.language}</Text>
          </View>
        )}
      </View>
      {item.description ? (
        <Text style={styles.repoDesc} numberOfLines={2}>{item.description}</Text>
      ) : null}
      <View style={styles.repoFooter}>
        <View style={styles.repoStats}>
          {item.stars !== undefined && (
            <View style={styles.stat}>
              <FontAwesome6 name="star" size={10} color={colors.textMuted} />
              <Text style={styles.statText}>{item.stars}</Text>
            </View>
          )}
          {item.forks !== undefined && (
            <View style={styles.stat}>
              <FontAwesome6 name="code-branch" size={10} color={colors.textMuted} />
              <Text style={styles.statText}>{item.forks}</Text>
            </View>
          )}
          <Text style={styles.sizeText}>{(item.size / 1024).toFixed(1)} MB</Text>
        </View>
        <Text style={styles.dateText}>
          {new Date(item.updated_at).toLocaleDateString()}
        </Text>
      </View>
    </View>
  );

  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle={isDark ? 'light' : 'dark'} scrollable>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <MenuButton onPress={onOpenSidebar} />
          <Text style={styles.headerTitle}>GitHub</Text>
          <Pressable style={styles.refreshBtn} onPress={fetchRepos}>
            <FontAwesome6 name="rotate" size={14} color={colors.textSecondary} />
          </Pressable>
        </View>

        {/* Token Status */}
        {!tokenConfigured && (
          <View style={styles.tokenBar}>
            <View style={styles.tokenLeft}>
              <FontAwesome6 name="key" size={12} color={colors.warning} />
              <Text style={styles.tokenLabel}>GitHub Token</Text>
            </View>
            <Text style={styles.tokenStatus}>未配置</Text>
          </View>
        )}

        {/* View Mode Tabs */}
        <View style={styles.tabs}>
          <Pressable
            style={[styles.tab, viewMode === 'my' && styles.tabActive]}
            onPress={() => { setViewMode('my'); fetchRepos(); }}
          >
            <Text style={[styles.tabText, viewMode === 'my' && styles.tabTextActive]}>我的仓库</Text>
          </Pressable>
          <Pressable
            style={[styles.tab, viewMode === 'search' && styles.tabActive]}
            onPress={() => setViewMode('search')}
          >
            <Text style={[styles.tabText, viewMode === 'search' && styles.tabTextActive]}>搜索</Text>
          </Pressable>
        </View>

        {/* Search */}
        <View style={styles.searchBar}>
          <FontAwesome6 name="magnifying-glass" size={14} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder={viewMode === 'search' ? '搜索 GitHub 仓库...' : '筛选仓库...'}
            placeholderTextColor={colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={viewMode === 'search' ? searchRepos : undefined}
            returnKeyType="search"
          />
          {viewMode === 'search' && searchQuery.trim() ? (
            <Pressable onPress={searchRepos}>
              <FontAwesome6 name="arrow-right" size={14} color={colors.primary} />
            </Pressable>
          ) : null}
        </View>

        {/* Repository List */}
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <FlatList
            data={repos}
            renderItem={renderRepo}
            keyExtractor={(item) => item.id.toString()}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <View style={styles.emptyIcon}>
                  <FontAwesome6 name="github" size={28} color={colors.textMuted} />
                </View>
                <Text style={styles.emptyText}>
                  {tokenConfigured ? '暂无仓库' : '未连接 GitHub'}
                </Text>
                <Text style={styles.emptyHint}>
                  {tokenConfigured
                    ? '下拉刷新或搜索仓库'
                    : '在设置中配置 GitHub Token\n即可浏览和管理你的仓库'}
                </Text>
              </View>
            }
          />
        )}
      </View>
    </Screen>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  headerTitle: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  refreshBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tokenBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderRadius: radius.md,
  },
  tokenLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tokenLabel: { fontSize: fontSize.sm, color: colors.warning },
  tokenStatus: { fontSize: fontSize.sm, color: colors.warning, fontWeight: '600' },
  tabs: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  tab: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated,
  },
  tabActive: { backgroundColor: colors.primary },
  tabText: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '600' },
  tabTextActive: { color: colors.textPrimary },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    gap: spacing.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    padding: 0,
  },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  repoCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  repoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  repoNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  repoName: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.textPrimary,
    flex: 1,
  },
  langBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    backgroundColor: 'rgba(167, 139, 250, 0.15)',
    borderRadius: radius.sm,
  },
  langText: { fontSize: fontSize.xs, color: colors.primary },
  repoDesc: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    lineHeight: 18,
  },
  repoFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  repoStats: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statText: { fontSize: fontSize.xs, color: colors.textMuted },
  sizeText: { fontSize: fontSize.xs, color: colors.textMuted },
  dateText: { fontSize: fontSize.xs, color: colors.textMuted },
  emptyState: { alignItems: 'center', paddingTop: spacing.xxl * 2 },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  emptyText: { fontSize: fontSize.md, fontWeight: '600', color: colors.textPrimary, marginBottom: spacing.xs },
  emptyHint: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
