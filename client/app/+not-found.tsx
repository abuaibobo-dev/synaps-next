import { View, Text, StyleSheet } from 'react-native';
import { Link } from 'expo-router';

export default function NotFoundScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        页面不存在
      </Text>
      <Link href="/" style={styles.link}>
        返回首页
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#121212' },
  title: { color: '#F4F4F5', fontSize: 16 },
  link: { color: '#8B8BFF', marginTop: 24 },
});
