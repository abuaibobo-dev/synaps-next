import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { View, StyleSheet, Modal, Text, Pressable } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Screen } from '@/components/Screen';
import { Sidebar, type ModuleKey } from '@/components/Sidebar';
import { useThemeColors } from '@/components/ThemeProvider';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';
import { FontAwesome6 } from '@expo/vector-icons';

import ProjectsScreen from '@/screens/projects';
import AgentScreen from '@/screens/agent';
import CodeScreen from '@/screens/code';
import ApkScreen from '@/screens/apk';
import LogsScreen from '@/screens/logs';
import GithubScreen from '@/screens/github';
import TasksScreen from '@/screens/tasks';
import SettingsScreen from '@/screens/settings';
import Animated, { FadeIn } from 'react-native-reanimated';

export default function WorkspaceScreen() {
  const { colors, isDark } = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [activeModule, setActiveModule] = useState<ModuleKey>('projects');
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  useEffect(() => {
    AsyncStorage.getItem('miaobi.onboarded')
      .then((v) => setOnboarded(v === '1'))
      .catch(() => setOnboarded(true));
    AsyncStorage.getItem('miaobi.lastModule')
      .then((v) => {
        if (v === 'projects' || v === 'agent' || v === 'code' || v === 'apk' || v === 'logs' || v === 'github' || v === 'tasks' || v === 'settings') {
          setActiveModule(v);
        }
      })
      .catch(() => undefined);
  }, []);

  const finishOnboarding = useCallback((module?: ModuleKey) => {
    AsyncStorage.setItem('miaobi.onboarded', '1').catch(() => undefined);
    setOnboarded(true);
    if (module) setActiveModule(module);
  }, []);

  const handleOpenSidebar = useCallback(() => {
    setSidebarVisible(true);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSidebarVisible(false);
  }, []);

  const handleModuleChange = useCallback((key: ModuleKey) => {
    setActiveModule(key);
    AsyncStorage.setItem('miaobi.lastModule', key).catch(() => undefined);
  }, []);

  const renderModule = () => {
    switch (activeModule) {
      case 'projects':
        return <ProjectsScreen onOpenSidebar={handleOpenSidebar} />;
      case 'agent':
        return <AgentScreen onOpenSidebar={handleOpenSidebar} />;
      case 'code':
        return <CodeScreen onOpenSidebar={handleOpenSidebar} />;
      case 'apk':
        return <ApkScreen onOpenSidebar={handleOpenSidebar} />;
      case 'logs':
        return <LogsScreen onOpenSidebar={handleOpenSidebar} />;
      case 'github':
        return <GithubScreen onOpenSidebar={handleOpenSidebar} />;
      case 'tasks':
        return <TasksScreen onOpenSidebar={handleOpenSidebar} />;
      case 'settings':
        return <SettingsScreen onOpenSidebar={handleOpenSidebar} />;
      default:
        return <ProjectsScreen onOpenSidebar={handleOpenSidebar} />;
    }
  };

  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle={isDark ? 'light' : 'dark'} safeAreaEdges={['left', 'right']} scrollable>
      <View style={styles.container}>
        <Animated.View
          key={activeModule}
          entering={FadeIn.duration(200).withInitialValues({ opacity: 0 })}
          style={styles.moduleContainer}
        >
          {renderModule()}
        </Animated.View>
        <Sidebar
          visible={sidebarVisible}
          activeModule={activeModule}
          onModuleChange={handleModuleChange}
          onClose={handleCloseSidebar}
        />
        {onboarded === false && (
          <Modal transparent visible animationType="fade" onRequestClose={() => finishOnboarding()}>
            <View style={styles.onboardingOverlay}>
              <View style={styles.onboardingCard}>
                <View style={styles.onboardingLogo}>
                  <FontAwesome6 name="bolt" size={26} color="#FFFFFF" />
                </View>
                <Text style={styles.onboardingTitle}>Synaps</Text>
                <Text style={styles.onboardingSubtitle}>你手机上的 AI 开发工作台</Text>
                <Text style={styles.onboardingDesc}>
                  Agent 能读写代码、执行命令、管理 Git、控制手机，在手机上完成开发闭环。
                </Text>
                <Pressable style={styles.onboardingAction} onPress={() => finishOnboarding('projects')}>
                  <FontAwesome6 name="folder-plus" size={13} color="#FFFFFF" />
                  <Text style={styles.onboardingActionText}>新建一个项目</Text>
                </Pressable>
                <Pressable style={styles.onboardingAction} onPress={() => finishOnboarding('github')}>
                  <FontAwesome6 name="code-branch" size={13} color="#FFFFFF" />
                  <Text style={styles.onboardingActionText}>导入 GitHub 仓库</Text>
                </Pressable>
                <Pressable style={styles.onboardingAction} onPress={() => finishOnboarding('agent')}>
                  <FontAwesome6 name="comments" size={13} color="#FFFFFF" />
                  <Text style={styles.onboardingActionText}>开始一个 Agent 对话</Text>
                </Pressable>
                <Pressable style={styles.onboardingSkip} onPress={() => finishOnboarding()}>
                  <Text style={styles.onboardingSkipText}>直接进入</Text>
                </Pressable>
              </View>
            </View>
          </Modal>
        )}
      </View>
    </Screen>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgRoot,
  },
  moduleContainer: {
    flex: 1,
  },
  onboardingOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  onboardingCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    alignItems: 'center',
  },
  onboardingLogo: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  onboardingTitle: {
    fontSize: fontSize.xl,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  onboardingSubtitle: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    marginTop: 4,
  },
  onboardingDesc: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 19,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  onboardingAction: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 12,
    marginBottom: spacing.sm,
  },
  onboardingActionText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  onboardingSkip: {
    marginTop: spacing.xs,
    padding: spacing.sm,
  },
  onboardingSkipText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
});
