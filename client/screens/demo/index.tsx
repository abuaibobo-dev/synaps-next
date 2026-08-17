import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';

import { Screen } from '@/components/Screen';

export default function DemoPage() {
  return (
    <Screen statusBarStyle="auto">
      <View style={styles.container}>
        <Image
          style={styles.image}
          source="https://lf-coze-web-cdn.coze.cn/obj/eden-cn/lm-lgvj/ljhwZthlaukjlkulzlp/coze-coding/expo/coze-loading.gif"
        />
        <Text style={styles.title}>APP 开发中</Text>
        <Text style={styles.subtitle}>即将为您呈现应用界面</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  image: { width: 130, height: 109 },
  title: { fontSize: 16, fontWeight: '700', color: '#F4F4F5' },
  subtitle: { fontSize: 14, marginTop: 8, color: '#8A8A8E' },
});
