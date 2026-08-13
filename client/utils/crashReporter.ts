import { ErrorUtils } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'synaps_crash_logs';
const MAX_LOG = 10;

export function installCrashReporter(): void {
  const originalHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    try {
      const msg = `${new Date().toISOString()} [${isFatal ? 'FATAL' : 'ERROR'}] ${error?.message || String(error)}\n${error?.stack || ''}`;
      AsyncStorage.getItem(KEY)
        .then((raw) => {
          const list: string[] = JSON.parse(raw || '[]');
          list.push(msg);
          return AsyncStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_LOG)));
        })
        .catch(() => {});
    } catch {
      // ignore
    }
    originalHandler(error, isFatal);
  });
}

export async function getCrashLogs(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return JSON.parse(raw || '[]') as string[];
  } catch {
    return [];
  }
}

export async function clearCrashLogs(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
