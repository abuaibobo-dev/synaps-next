import { AuthProvider } from '@/contexts/AuthContext';
import { type ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WebOnlyColorSchemeUpdater } from './ColorSchemeUpdater';
import { WebOnlyPrettyScrollbar } from './PrettyScrollbar'
import { HeroUINativeProvider } from '@/heroui';
import { ThemeProvider } from './ThemeProvider';

function Provider({ children }: { children: ReactNode }) {
  return <SafeAreaProvider>
    <ThemeProvider>
      <WebOnlyColorSchemeUpdater>
        <WebOnlyPrettyScrollbar>
          <AuthProvider>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <HeroUINativeProvider>
                {children}
              </HeroUINativeProvider>
            </GestureHandlerRootView>
          </AuthProvider>
        </WebOnlyPrettyScrollbar>
      </WebOnlyColorSchemeUpdater>
    </ThemeProvider>
  </SafeAreaProvider>
}

export {
  Provider,
}
