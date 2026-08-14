import React from 'react';
import { Feather, FontAwesome6 } from '@expo/vector-icons';

export type AppIconName =
  // 任务状态
  | 'check-circle' | 'loader' | 'circle' | 'x-circle'
  // 工具类型
  | 'terminal' | 'file-text' | 'file-plus' | 'search' | 'git-branch'
  | 'package' | 'test-tube' | 'check-square' | 'shield' | 'globe' | 'smartphone'
  // 页面导航
  | 'folder' | 'bot' | 'code' | 'settings' | 'list-checks' | 'github' | 'box'
  // 控制按钮
  | 'x' | 'rotate-cw' | 'undo' | 'download' | 'chevron-down' | 'chevron-up'
  | 'stop' | 'spinner' | 'file-pen' | 'quote-left' | 'microchip' | 'bars'
  | 'copy' | 'share-2' | 'bolt' | 'file-export' | 'file-import';

// Feather 线性图标（统一线条风格），缺失的少量图标用 FontAwesome6 兜底
const FEATHER_NAMES: Partial<Record<AppIconName, keyof typeof Feather.glyphMap>> = {
  'check-circle': 'check-circle',
  loader: 'loader',
  circle: 'circle',
  'x-circle': 'x-circle',
  terminal: 'terminal',
  'file-text': 'file-text',
  'file-plus': 'file-plus',
  search: 'search',
  'git-branch': 'git-branch',
  package: 'package',
  'check-square': 'check-square',
  shield: 'shield',
  globe: 'globe',
  smartphone: 'smartphone',
  folder: 'folder',
  code: 'code',
  settings: 'settings',
  x: 'x',
  'rotate-cw': 'rotate-cw',
  download: 'download',
  'chevron-down': 'chevron-down',
  'chevron-up': 'chevron-up',
  github: 'github',
  copy: 'copy',
  'share-2': 'share-2',
  bolt: 'zap',
  box: 'box',
};

const FA6_FALLBACK: Partial<Record<AppIconName, React.ComponentProps<typeof FontAwesome6>['name']>> = {
  'test-tube': 'flask-vial',
  bot: 'robot',
  'list-checks': 'list-check',
  undo: 'rotate-left',
  stop: 'stop',
  spinner: 'spinner',
  'file-pen': 'file-pen',
  'quote-left': 'quote-left',
  microchip: 'microchip',
  bars: 'bars',
  'file-export': 'file-export',
  'file-import': 'file-import',
};

interface AppIconProps {
  name: AppIconName;
  size?: number;
  color?: string;
  spin?: boolean;
}

export function AppIcon({ name, size = 20, color = '#000', spin = false }: AppIconProps) {
  const featherName = FEATHER_NAMES[name];
  if (featherName) {
    return <Feather name={featherName} size={size} color={color} />;
  }
  const faName = FA6_FALLBACK[name];
  if (faName) {
    return <FontAwesome6 name={faName} size={size} color={color} spin={spin} />;
  }
  return <Feather name="circle" size={size} color={color} />;
}

// 工具名 → 图标语义名
const TOOL_ICON_MAP: Record<string, AppIconName> = {
  run_command: 'terminal',
  install_tool: 'terminal',
  read_file: 'file-text',
  write_file: 'file-plus',
  search_file: 'search',
  search_tools: 'search',
  list_dir: 'folder',
  git_commit_push: 'git-branch',
  trigger_build: 'package',
  check_build_status: 'package',
  run_tests: 'test-tube',
  generate_tests: 'test-tube',
  auto_test_fix: 'test-tube',
  run_lint: 'check-square',
  run_typecheck: 'check-square',
  analyze_code: 'check-square',
  auto_fix: 'check-square',
  security_scan: 'shield',
  security_fix: 'shield',
  mcp_list_servers: 'globe',
  mcp_list_tools: 'globe',
  mcp_call: 'globe',
  mcp_add_server: 'globe',
  device_action: 'smartphone',
  device_status: 'smartphone',
  harness_run: 'bot',
  harness_status: 'bot',
  team_plan: 'list-checks',
  team_execute: 'code',
  team_test: 'test-tube',
  team_review: 'check-square',
  project_export: 'file-export',
  project_import: 'file-import',
  system_diagnostics: 'shield',
};

export function toolIcon(tool: string): AppIconName {
  return TOOL_ICON_MAP[tool] || 'terminal';
}
