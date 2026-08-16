import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ComponentProps } from 'react';
import { LogBox, Text, View } from 'react-native';
import Toast, { ToastConfigParams } from 'react-native-toast-message';
import { Provider } from '@/components/Provider';
import { useThemeColors } from '@/components/ThemeProvider';
import { FontAwesome6 } from '@expo/vector-icons';
import { installCrashReporter } from '@/utils/crashReporter';

import '../global.css';

installCrashReporter();

LogBox.ignoreLogs([
  "TurboModuleRegistry.getEnforcing(...): 'RNMapsAirModule' could not be found",
  // 添加其它想暂时忽略的错误或警告信息
]);

type IconName = ComponentProps<typeof FontAwesome6>['name'];

/**
 * 紧凑小胶囊 Toast：替代默认的大白条，风格与设置页保存提示一致。
 * 全局生效（复制成功、审批结果等提示统一变小巧）。
 */
function CompactToast({
  text1,
  text2,
  icon,
  iconColor,
}: {
  text1?: string;
  text2?: string;
  icon: IconName;
  iconColor: string;
}) {
  const { colors } = useThemeColors();
  return (
    <View
      style={{
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 20,
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.border,
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 6,
        elevation: 4,
        maxWidth: '86%',
      }}
    >
      <FontAwesome6 name={icon} size={13} color={iconColor} />
      <Text style={{ fontSize: 13, color: colors.textPrimary, flexShrink: 1 }} numberOfLines={2}>
        {text1}
        {text2 ? ` ${text2}` : ''}
      </Text>
    </View>
  );
}

function ToastView() {
  const { colors } = useThemeColors();
  return (
    <Toast
      topOffset={60}
      visibilityTime={2200}
      config={{
        success: (props: ToastConfigParams<any>) => (
          <CompactToast {...props} icon="check-circle" iconColor={colors.success} />
        ),
        error: (props: ToastConfigParams<any>) => (
          <CompactToast {...props} icon="x-circle" iconColor={colors.error} />
        ),
      }}
    />
  );
}

export default function RootLayout() {
  return (
    <Provider>
      <Stack
        screenOptions={{
          animation: 'slide_from_right',
          gestureEnabled: true,
          gestureDirection: 'horizontal',
          headerShown: false
        }}
      >
        <Stack.Screen name="index" options={{ title: "" }} />
      </Stack>
      <ToastView />
    </Provider>
  );
}
