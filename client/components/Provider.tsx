import { type ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WebOnlyColorSchemeUpdater } from './ColorSchemeUpdater';
import { WebOnlyPrettyScrollbar } from './PrettyScrollbar'
import { ThemeProvider } from './ThemeProvider';

function Provider({ children }: { children: ReactNode }) {
  return <SafeAreaProvider>
    <ThemeProvider>
      <WebOnlyColorSchemeUpdater>
        <WebOnlyPrettyScrollbar>
          <GestureHandlerRootView style={{ flex: 1 }}>
            {children}
          </GestureHandlerRootView>
        </WebOnlyPrettyScrollbar>
      </WebOnlyColorSchemeUpdater>
    </ThemeProvider>
  </SafeAreaProvider>
}

export {
  Provider,
}
