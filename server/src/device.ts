import { randomUUID } from 'crypto';
import { queryOne, runSql, saveDb } from './db.js';

export type DeviceActionType = 'tap' | 'swipe' | 'screenshot' | 'ui_dump' | 'back' | 'home' | 'launch_app';

export interface DeviceAction {
  id: string;
  type: DeviceActionType;
  params: Record<string, unknown>;
  status: 'pending' | 'done' | 'error';
  result?: string;
  error?: string;
  createdAt: number;
  expiresAt: number;
}

const ACTION_TTL_MS = 60_000;
const queue = new Map<string, DeviceAction>();

export function deviceControlEnabled(): boolean {
  try {
    const row = queryOne('SELECT value FROM settings WHERE key = ?', ['device_control_enabled']);
    return !!(row && typeof row.value === 'string' && row.value === '1');
  } catch {
    return false;
  }
}

export function setDeviceControlEnabled(enabled: boolean): void {
  runSql(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('device_control_enabled', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [enabled ? '1' : '0']
  );
  saveDb();
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, action] of queue) {
    if (action.status !== 'pending' || action.expiresAt < now) queue.delete(id);
  }
}

export function enqueueDeviceAction(type: DeviceActionType, params: Record<string, unknown> = {}): DeviceAction {
  pruneExpired();
  const now = Date.now();
  const action: DeviceAction = {
    id: randomUUID(),
    type,
    params,
    status: 'pending',
    createdAt: now,
    expiresAt: now + ACTION_TTL_MS,
  };
  queue.set(action.id, action);
  return action;
}

export function takePendingDeviceAction(): DeviceAction | null {
  pruneExpired();
  for (const action of queue.values()) {
    if (action.status === 'pending') return action;
  }
  return null;
}

export function completeDeviceAction(id: string, ok: boolean, result?: string, error?: string): DeviceAction | null {
  const action = queue.get(id);
  if (!action) return null;
  action.status = ok ? 'done' : 'error';
  if (ok) action.result = result;
  else action.error = error;
  return action;
}

export function getDeviceAction(id: string): DeviceAction | undefined {
  return queue.get(id);
}

export function deviceStatusSummary(): string {
  const enabled = deviceControlEnabled();
  const pending = [...queue.values()].filter((a) => a.status === 'pending').length;
  return `设备控制：${enabled ? '已启用' : '未启用'}\n等待执行的动作：${pending}\n提示：需要在系统设置里开启 Synaps 的无障碍服务（设置页 → 设备控制 → 打开无障碍设置），动作才会被执行。`;
}
