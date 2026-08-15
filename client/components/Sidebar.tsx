import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  TouchableWithoutFeedback,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  ReduceMotion,
  interpolate,
} from 'react-native-reanimated';
import { FontAwesome6 } from '@expo/vector-icons';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';
import { useThemeColors } from './ThemeProvider';
import { AppIcon, type AppIconName } from './AppIcon';
import { getApiBase } from '@/utils';
import { emit } from '@/utils/appBus';

const API_BASE = getApiBase();
const COLLAPSED_WIDTH = 64;
const PHONE_WIDTH = 280;
const TABLET_WIDTH = 320;
const NAV_HEIGHT = 44;

export type ModuleKey =
  | 'projects'
  | 'agent'
  | 'code'
  | 'terminal'
  | 'apk'
  | 'logs'
  | 'github'
  | 'tasks'
  | 'settings';

interface SidebarModule {
  key: ModuleKey;
  label: string;
  icon: AppIconName;
}

const MODULES: SidebarModule[] = [
  { key: 'projects', label: '项目', icon: 'folder' },
  { key: 'agent', label: 'Agent', icon: 'bot' },
  { key: 'code', label: '代码', icon: 'code' },
  { key: 'terminal', label: '终端', icon: 'terminal' },
  { key: 'apk', label: 'APK', icon: 'package' },
  { key: 'logs', label: '日志', icon: 'file-text' },
  { key: 'github', label: 'GitHub', icon: 'github' },
  { key: 'tasks', label: '任务', icon: 'list-checks' },
  { key: 'settings', label: '设置', icon: 'settings' },
];

interface SidebarColors {
  bg: string;
  bgActive: string;
  iconDefault: string;
  iconActive: string;
  textDefault: string;
  textActive: string;
  divider: string;
  brand: string;
  brandSub: string;
}

function buildSidebarColors(isDark: boolean): SidebarColors {
  if (isDark) {
    return {
      bg: '#121212',
      bgActive: '#1A1A1A',
      iconDefault: '#6A6A6A',
      iconActive: '#FFFFFF',
      textDefault: '#B0B0B0',
      textActive: '#FFFFFF',
      divider: '#2A2A2A',
      brand: '#FFFFFF',
      brandSub: '#6A6A6A',
    };
  }
  return {
    bg: '#FFFFFF',
    bgActive: '#F0F0F0',
    iconDefault: '#A0A0A0',
    iconActive: '#1A1A1A',
    textDefault: '#6A6A6A',
    textActive: '#1A1A1A',
    divider: '#E0E0E0',
    brand: '#1A1A1A',
    brandSub: '#A0A0A0',
  };
}

interface RecentProject {
  id: string;
  name: string;
  path: string;
}

interface SidebarProps {
  visible: boolean;
  activeModule: ModuleKey;
  onModuleChange: (key: ModuleKey) => void;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 KB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function Sidebar({ visible, activeModule, onModuleChange, onClose }: SidebarProps) {
  const { isDark } = useThemeColors();
  const c = useMemo(() => buildSidebarColors(isDark), [isDark]);
  const styles = useMemo(() => createStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const expandedWidth = windowWidth >= 600 ? TABLET_WIDTH : PHONE_WIDTH;

  const [collapsed, setCollapsed] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [storageInfo, setStorageInfo] = useState<{ bytes: number; projects: number } | null>(null);
  const [tooltip, setTooltip] = useState<string | null>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const progress = useSharedValue(visible ? 1 : 0);
  const expand = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      progress.set(
        withTiming(1, { duration: 300, easing: Easing.out(Easing.ease), reduceMotion: ReduceMotion.System })
      );
      (async () => {
        try {
          const res = await fetch(`${API_BASE}/api/v1/projects/recent?limit=3`);
          if (res.ok) {
            const data = await res.json();
            setRecentProjects((data.projects || []).slice(0, 3));
          }
        } catch {
          // 忽略
        }
        try {
          const res = await fetch(`${API_BASE}/api/v1/diagnostics`);
          if (res.ok) {
            const data = await res.json();
            setStorageInfo({
              bytes: data?.db?.fileSizeBytes ?? 0,
              projects: data?.db?.projects ?? 0,
            });
          }
        } catch {
          // 忽略
        }
      })();
    } else {
      progress.set(withTiming(0, { duration: 250, easing: Easing.in(Easing.ease) }));
    }
  }, [visible, progress]);

  // 展开/收起：宽度随动画值平滑变化（300ms）
  useEffect(() => {
    expand.set(
      withTiming(collapsed ? 0 : 1, {
        duration: 300,
        easing: Easing.out(Easing.ease),
        reduceMotion: ReduceMotion.System,
      })
    );
  }, [collapsed, expand]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
  }));

  const panelStyle = useAnimatedStyle(() => {
    const w = interpolate(expand.get(), [0, 1], [COLLAPSED_WIDTH, expandedWidth]);
    return {
      width: w,
      transform: [{ translateX: interpolate(progress.get(), [0, 1], [-w, 0]) }],
    };
  });

  const switchProject = async (project: RecentProject) => {
    emit('project:changed', project);
    try {
      await fetch(`${API_BASE}/api/v1/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_project_id: project.id }),
      });
    } catch {
      // 忽略
    }
    onClose();
  };

  const showTooltip = (label: string) => {
    if (!collapsed) return;
    setTooltip(label);
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    tooltipTimer.current = setTimeout(() => setTooltip(null), 1600);
  };

  useEffect(() => {
    return () => {
      if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    };
  }, []);

  return (
    <View
      style={[StyleSheet.absoluteFill, { zIndex: 1000 }]}
      pointerEvents={visible ? 'auto' : 'none'}
    >
      {/* 点击外部自动收起 */}
      <TouchableWithoutFeedback onPress={onClose}>
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.6)' }, backdropStyle]}
        />
      </TouchableWithoutFeedback>

      {/* 侧栏面板 */}
      <Animated.View
        style={[
          styles.sidebar,
          panelStyle,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        {/* 品牌区 */}
        {!collapsed ? (
          <View style={styles.brandBlock}>
            <View style={styles.brandRow}>
              <View style={styles.logoIcon}>
                <AppIcon name="bolt" size={18} color="#FFFFFF" />
              </View>
              <Text style={styles.brandTitle}>CORE</Text>
            </View>
          </View>
        ) : (
          <View style={[styles.brandBlock, styles.brandBlockCollapsed]}>
            <View style={styles.logoIcon}>
              <AppIcon name="bolt" size={18} color="#FFFFFF" />
            </View>
          </View>
        )}
        <View style={styles.divider} />

        {/* 导航列表 */}
        <View style={styles.moduleList}>
          {MODULES.map((mod) => {
            const isActive = mod.key === activeModule;
            return (
              <View key={mod.key}>
                <Pressable
                  style={[styles.moduleItem, isActive && styles.moduleItemActive]}
                  onPress={() => {
                    onModuleChange(mod.key);
                    onClose();
                  }}
                  onLongPress={() => showTooltip(mod.label)}
                  delayLongPress={300}
                >
                  {isActive && <View style={styles.activeBar} />}
                  <View style={styles.moduleIconWrap}>
                    <AppIcon
                      name={mod.icon}
                      size={20}
                      color={isActive ? c.iconActive : c.iconDefault}
                    />
                  </View>
                  {!collapsed && (
                    <Text
                      style={[styles.moduleLabel, isActive && styles.moduleLabelActive]}
                      numberOfLines={1}
                    >
                      {mod.label}
                    </Text>
                  )}
                </Pressable>
                {collapsed && tooltip === mod.label && (
                  <View style={styles.tooltip} pointerEvents="none">
                    <Text style={styles.tooltipText}>{mod.label}</Text>
                  </View>
                )}
              </View>
            );
          })}
        </View>

        {/* 底部：最近项目 + 存储占用 */}
        <View style={styles.footer}>
          {!collapsed && recentProjects.length > 0 && (
            <>
              <Text style={styles.footerTitle}>最近项目</Text>
              <View style={styles.recentList}>
                {recentProjects.map((p) => (
                  <Pressable key={p.id} style={styles.recentItem} onPress={() => switchProject(p)}>
                    <AppIcon name="folder" size={14} color={c.iconDefault} />
                    <Text style={styles.recentName} numberOfLines={1}>
                      {p.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}
          {!collapsed && (
            <View style={styles.storageRow}>
              <AppIcon name="box" size={12} color={c.iconDefault} />
              <Text style={styles.storageText} numberOfLines={1}>
                {storageInfo
                  ? `数据库 ${formatBytes(storageInfo.bytes)} · ${storageInfo.projects} 个项目`
                  : '存储占用计算中...'}
              </Text>
            </View>
          )}
          <Pressable style={styles.collapseBtn} onPress={() => setCollapsed(!collapsed)} hitSlop={8}>
            <FontAwesome6
              name={collapsed ? 'angles-right' : 'angles-left'}
              size={14}
              color={c.iconDefault}
            />
            {!collapsed && <Text style={styles.collapseText}>收起</Text>}
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

// Hamburger Button
interface MenuButtonProps {
  onPress: () => void;
}

export function MenuButton({ onPress }: MenuButtonProps) {
  const { colors, isDark } = useThemeColors();
  const styles = useMemo(
    () => createStyles(buildSidebarColors(isDark)),
    [isDark]
  );
  return (
    <Pressable onPress={onPress} style={styles.menuButton}>
      <FontAwesome6 name="bars" size={18} color={colors.textPrimary} />
    </Pressable>
  );
}

const createStyles = (c: SidebarColors) =>
  StyleSheet.create({
    sidebar: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      backgroundColor: c.bg,
      borderRightWidth: 1,
      borderRightColor: c.divider,
      justifyContent: 'space-between',
    },
    brandBlock: {
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.lg,
      paddingBottom: spacing.lg,
      gap: 4,
    },
    brandBlockCollapsed: {
      paddingHorizontal: 0,
      alignItems: 'center',
    },
    brandRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    logoIcon: {
      width: 28,
      height: 28,
      borderRadius: 8,
      backgroundColor: c.brand,
      alignItems: 'center',
      justifyContent: 'center',
    },
    brandTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: '#FFFFFF',
      letterSpacing: 1,
    },
    divider: {
      height: 1,
      backgroundColor: c.divider,
      marginHorizontal: spacing.lg,
    },
    moduleList: {
      flex: 1,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
      gap: 2,
    },
    moduleItem: {
      height: NAV_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 8,
      gap: spacing.md,
      paddingHorizontal: spacing.sm,
      position: 'relative',
    },
    moduleItemActive: {
      backgroundColor: c.bgActive,
    },
    activeBar: {
      position: 'absolute',
      left: 0,
      top: 10,
      bottom: 10,
      width: 2,
      borderRadius: 1,
      backgroundColor: c.brand,
    },
    moduleIconWrap: {
      width: 28,
      alignItems: 'center',
      justifyContent: 'center',
    },
    moduleLabel: {
      flex: 1,
      fontSize: 14,
      fontWeight: '500',
      color: c.textDefault,
    },
    moduleLabelActive: {
      color: c.textActive,
      fontWeight: '600',
    },
    tooltip: {
      position: 'absolute',
      left: COLLAPSED_WIDTH - 8,
      top: 10,
      backgroundColor: c.bgActive,
      borderRadius: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: c.divider,
      zIndex: 50,
    },
    tooltipText: {
      fontSize: fontSize.sm,
      color: c.textActive,
      fontWeight: '500',
    },
    footer: {
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.lg,
      gap: spacing.sm,
    },
    footerTitle: {
      fontSize: fontSize.xs,
      fontWeight: '700',
      color: c.iconDefault,
      letterSpacing: 1.5,
      textTransform: 'uppercase',
      marginTop: spacing.xs,
    },
    recentList: {
      gap: 2,
    },
    recentItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      height: 34,
      borderRadius: 6,
      paddingHorizontal: spacing.sm,
    },
    recentName: {
      flex: 1,
      fontSize: fontSize.sm,
      color: c.textDefault,
    },
    storageRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingTop: spacing.xs,
      borderTopWidth: 1,
      borderTopColor: c.divider,
      marginTop: spacing.xs,
    },
    storageText: {
      flex: 1,
      fontSize: fontSize.xs,
      color: c.iconDefault,
    },
    collapseBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      height: 36,
      borderRadius: 8,
      backgroundColor: c.bgActive,
      borderWidth: 1,
      borderColor: c.divider,
    },
    collapseText: {
      fontSize: fontSize.sm,
      color: c.iconDefault,
    },
    menuButton: {
      width: 40,
      height: 40,
      borderRadius: radius.md,
      backgroundColor: c.bgActive,
      borderWidth: 1,
      borderColor: c.divider,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
