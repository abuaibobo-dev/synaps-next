import React, { useState, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { Screen } from '@/components/Screen';
import { Sidebar, type ModuleKey } from '@/components/Sidebar';
import { colors } from '@/utils/theme';

import ProjectsScreen from '@/screens/projects';
import AgentScreen from '@/screens/agent';
import CodeScreen from '@/screens/code';
import TerminalScreen from '@/screens/terminal';
import ApkScreen from '@/screens/apk';
import LogsScreen from '@/screens/logs';
import GithubScreen from '@/screens/github';
import SettingsScreen from '@/screens/settings';

export default function WorkspaceScreen() {
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [activeModule, setActiveModule] = useState<ModuleKey>('projects');

  const handleOpenSidebar = useCallback(() => {
    setSidebarVisible(true);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSidebarVisible(false);
  }, []);

  const handleModuleChange = useCallback((key: ModuleKey) => {
    setActiveModule(key);
  }, []);

  const renderModule = () => {
    switch (activeModule) {
      case 'projects':
        return <ProjectsScreen onOpenSidebar={handleOpenSidebar} />;
      case 'agent':
        return <AgentScreen onOpenSidebar={handleOpenSidebar} />;
      case 'code':
        return <CodeScreen onOpenSidebar={handleOpenSidebar} />;
      case 'terminal':
        return <TerminalScreen onOpenSidebar={handleOpenSidebar} />;
      case 'apk':
        return <ApkScreen onOpenSidebar={handleOpenSidebar} />;
      case 'logs':
        return <LogsScreen onOpenSidebar={handleOpenSidebar} />;
      case 'github':
        return <GithubScreen onOpenSidebar={handleOpenSidebar} />;
      case 'settings':
        return <SettingsScreen onOpenSidebar={handleOpenSidebar} />;
      default:
        return <ProjectsScreen onOpenSidebar={handleOpenSidebar} />;
    }
  };

  return (
    <Screen backgroundColor={colors.bgRoot} statusBarStyle="light" safeAreaEdges={['left', 'right']}>
      <View style={styles.container}>
        {renderModule()}
        <Sidebar
          visible={sidebarVisible}
          activeModule={activeModule}
          onModuleChange={handleModuleChange}
          onClose={handleCloseSidebar}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgRoot,
  },
});
