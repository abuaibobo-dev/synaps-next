import { NativeModules, Platform } from 'react-native';
import { getApiBase } from '@/utils';

const API_BASE = getApiBase();

export interface DeviceAction {
  id: string;
  type: string;
  params: Record<string, unknown>;
}

export interface DeviceStatus {
  enabled: boolean;
  serviceConnected: boolean;
  pending?: { id: string; type: string } | null;
}

const native = Platform.OS === 'android' ? NativeModules.DeviceControl : null;

/**
 * 查询原生无障碍服务是否已连接（仅 Android）。
 */
export async function getNativeStatus(): Promise<{ serviceConnected: boolean }> {
  if (!native) return { serviceConnected: false };
  try {
    return (await native.getStatus()) as { serviceConnected: boolean };
  } catch {
    return { serviceConnected: false };
  }
}

/**
 * 查询后端设备控制总状态（启用开关 + 待执行动作）。
 */
export async function getDeviceStatus(): Promise<DeviceStatus> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/device/status`);
    const data = (await res.json()) as DeviceStatus;
    const nativeStatus = await getNativeStatus();
    return { ...data, serviceConnected: nativeStatus.serviceConnected };
  } catch {
    return { enabled: false, serviceConnected: false };
  }
}

/**
 * 设置设备控制开关（后端持久化偏好）。
 */
export async function setDeviceControlEnabled(enabled: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/device/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const data = (await res.json()) as { enabled?: boolean };
    return data.enabled === true;
  } catch {
    return false;
  }
}

/**
 * 轮询执行设备动作：把后端队列里的动作交给原生无障碍服务执行，并回传结果。
 * 返回停止函数。仅在 Android + 原生桥可用时工作。
 */
export function startDeviceBridge(): () => void {
  if (!native) return () => undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const poll = async () => {
    if (stopped) return;
    try {
      const res = await fetch(`${API_BASE}/api/v1/device/pending`);
      const data = (await res.json()) as { action: DeviceAction | null };
      if (data.action && !stopped) {
        const action = data.action;
        try {
          const result = await native.executeAction(action.id, action.type, action.params || {});
          const payload = {
            id: action.id,
            ok: true,
            result: JSON.stringify(result),
          };
          await fetch(`${API_BASE}/api/v1/device/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
        } catch (err: any) {
          await fetch(`${API_BASE}/api/v1/device/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: action.id,
              ok: false,
              error: err?.message || String(err),
            }),
          });
        }
      }
    } catch {
      // 后端未就绪时静默重试
    } finally {
      if (!stopped) timer = setTimeout(poll, 500);
    }
  };

  poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
