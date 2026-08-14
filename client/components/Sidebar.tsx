import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  TouchableWithoutFeedback,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome6 } from '@expo/vector-icons';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';
import { useThemeColors } from './ThemeProvider';

const SIDEBAR_WIDTH = 280;

export type ModuleKey =
  | 'projects'
  | 'agent'
  | 'code'
  | 'terminal'
  | 'apk'
  | 'logs'
  | 'github'
  | 'settings';

interface SidebarModule {
  key: ModuleKey;
  label: string;
  icon: React.ComponentProps<typeof FontAwesome6>['name'];
}

const MODULES: SidebarModule[] = [
  { key: 'projects', label: '项目', icon: 'folder-open' },
  { key: 'agent', label: 'Agent', icon: 'robot' },
  { key: 'code', label: '代码', icon: 'code' },
  { key: 'terminal', label: '终端', icon: 'terminal' },
  { key: 'apk', label: 'APK', icon: 'box' },
  { key: 'logs', label: '日志', icon: 'file-lines' },
  { key: 'github', label: 'GitHub', icon: 'github' },
  { key: 'settings', label: '设置', icon: 'gear' },
];

interface SidebarProps {
  visible: boolean;
  activeModule: ModuleKey;
  onModuleChange: (key: ModuleKey) => void;
  onClose: () => void;
}

export function Sidebar({ visible, activeModule, onModuleChange, onClose }: SidebarProps) {
  const { colors } = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [animValues] = useState(() => ({
    translateX: new Animated.Value(-SIDEBAR_WIDTH),
    opacity: new Animated.Value(visible ? 1 : 0),
  }));
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(animValues.translateX, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(animValues.opacity, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(animValues.translateX, {
          toValue: -SIDEBAR_WIDTH,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(animValues.opacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, animValues]);

  if (!visible) return null;

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 1000 }]}>
      {/* Overlay */}
      <TouchableWithoutFeedback onPress={onClose}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: 'rgba(0,0,0,0.6)', opacity: animValues.opacity },
          ]}
        />
      </TouchableWithoutFeedback>

      {/* Sidebar Panel */}
      <Animated.View
        style={[
          styles.sidebar,
          {
            transform: [{ translateX: animValues.translateX }],
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.logoRow}>
            <View style={styles.logoIcon}>
              <FontAwesome6 name="bolt" size={18} color={colors.primary} />
            </View>
            <Text style={styles.logoText}>SYNAPS</Text>
          </View>
          <Text style={styles.versionText}>v0.1 WORKBENCH</Text>
        </View>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Module List */}
        <View style={styles.moduleList}>
          {MODULES.map((mod) => {
            const isActive = mod.key === activeModule;
            return (
              <Pressable
                key={mod.key}
                style={[styles.moduleItem, isActive && styles.moduleItemActive]}
                onPress={() => {
                  onModuleChange(mod.key);
                  onClose();
                }}
              >
                <View style={[styles.iconContainer, isActive && styles.iconContainerActive]}>
                  <FontAwesome6
                    name={mod.icon}
                    size={16}
                    color={isActive ? colors.primary : colors.textSecondary}
                  />
                </View>
                <Text
                  style={[
                    styles.moduleLabel,
                    isActive && styles.moduleLabelActive,
                  ]}
                >
                  {mod.label}
                </Text>
                {isActive && <View style={styles.activeIndicator} />}
              </Pressable>
            );
          })}
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <View style={styles.footerLine}>
            <View style={styles.statusDot} />
            <Text style={styles.footerText}>DEEPSEEK CONNECTED</Text>
          </View>
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
  const { colors } = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable onPress={onPress} style={styles.menuButton}>
      <FontAwesome6 name="bars" size={18} color={colors.textPrimary} />
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  sidebar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: SIDEBAR_WIDTH,
    backgroundColor: colors.bgCard,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    justifyContent: 'space-between',
  },
  header: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  logoIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.primaryGlow,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: 3,
  },
  versionText: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    letterSpacing: 2,
    marginTop: spacing.xs,
    marginLeft: 48,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.xl,
  },
  moduleList: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    gap: 2,
  },
  moduleItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    gap: spacing.md,
  },
  moduleItemActive: {
    backgroundColor: colors.primaryGlow,
  },
  iconContainer: {
    width: 32,
    height: 32,
    borderRadius: radius.sm + 2,
    backgroundColor: 'rgba(255,255,255,0.03)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconContainerActive: {
    backgroundColor: colors.primaryGlow,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  moduleLabel: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontWeight: '500',
    flex: 1,
  },
  moduleLabelActive: {
    color: colors.primary,
    fontWeight: '600',
  },
  activeIndicator: {
    width: 3,
    height: 16,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  footer: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
  },
  footerLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  footerText: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    letterSpacing: 1.5,
  },
  menuButton: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
