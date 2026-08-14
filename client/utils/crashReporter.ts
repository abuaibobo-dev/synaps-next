import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'synaps_crash_logs';
const MAX_LOG = 10;

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;

interface GlobalErrorUtils {
  getGlobalHandler(): ErrorHandler;
  setGlobalHandler(handler: ErrorHandler): void;
}

export function installCrashReporter(): void {
  // ErrorUtils is a global injected by React Native's runtime, it is NOT
  // exported from the 'react-native' package (RN 0.81+). Importing it as a
  // named export yields `undefined` and crashes the app at startup.
  const ErrorUtils = (globalThis as { ErrorUtils?: GlobalErrorUtils }).ErrorUtils;
  if (!ErrorUtils) return;

  const originalHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    try {
      const msg = `${new Date().toISOString()} [${isFatal ? 'FATAL' : 'ERROR'}] ${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? error.stack || '' : ''}`;
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
