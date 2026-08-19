import React, { useCallback, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, Share, Platform } from 'react-native';
import { SvgXml } from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import { FontAwesome6 } from '@expo/vector-icons';
import { spacing, radius, fontSize } from '@/utils/theme';
import type { ThemeColors } from '@/utils/theme';

/** 从 SVG 字符串解析 viewBox 尺寸（宽高比用于自适应渲染） */
function parseViewBox(svg: string): { w: number; h: number } {
  const m = svg.match(/viewBox=["']0\s+0\s+(\d+)\s+(\d+)["']/);
  if (m) return { w: Number(m[1]) || 860, h: Number(m[2]) || 480 };
  const wm = svg.match(/width=["'](\d+)["']/);
  const hm = svg.match(/height=["'](\d+)["']/);
  return { w: wm ? Number(wm[1]) : 860, h: hm ? Number(hm[1]) : 480 };
}

export default function DiagramView({ svg, colors }: { svg: string; colors: ThemeColors }) {
  const dims = useMemo(() => parseViewBox(svg), [svg]);
  const aspect = dims.w > 0 && dims.h > 0 ? dims.h / dims.w : 0.6;

  const copySvg = useCallback(async () => {
    await Clipboard.setStringAsync(svg);
    Toast.show({ type: 'success', text1: 'SVG 已复制' });
  }, [svg]);

  const exportSvg = useCallback(async () => {
    try {
      await Share.share({ message: svg, title: '妙笔 图表 (SVG)' });
    } catch {
      Toast.show({ type: 'error', text1: '导出失败' });
    }
  }, [svg]);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titleWrap}>
          <FontAwesome6 name="diagram-project" size={11} color={colors.textSecondary} />
          <Text style={styles.title}>图表</Text>
        </View>
        <View style={styles.actions}>
          <Pressable style={styles.actionBtn} onPress={copySvg} hitSlop={6}>
            <FontAwesome6 name="copy" size={10} color={colors.textSecondary} />
            <Text style={styles.actionText}>复制 SVG</Text>
          </Pressable>
          <Pressable style={styles.actionBtn} onPress={exportSvg} hitSlop={6}>
            <FontAwesome6 name="share-nodes" size={10} color={colors.textSecondary} />
            <Text style={styles.actionText}>导出</Text>
          </Pressable>
        </View>
      </View>
      <View style={[styles.svgWrap, { aspectRatio: 1 / aspect }]}>
        <SvgXml xml={svg} width="100%" height="100%" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3A3A3A',
    backgroundColor: '#0D0D0D',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#1A1A1A',
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  titleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    fontSize: 11,
    fontWeight: '700',
    color: '#E8E8EC',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
  },
  actionText: {
    fontSize: 10,
    color: '#A0A0A4',
    fontWeight: '600',
  },
  svgWrap: {
    width: '100%',
    backgroundColor: '#0D0D0D',
  },
});
