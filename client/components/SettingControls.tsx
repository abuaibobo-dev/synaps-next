import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, TextInput, StyleSheet, type ViewStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolateColor,
  interpolate,
  Easing,
} from 'react-native-reanimated';
import type { ThemeColors } from '@/utils/theme';
import { AppIcon, type AppIconName } from './AppIcon';

// 设置页规范色映射：深色按用户规范硬编码，浅色适配主题
export interface SettingColors {
  cardBg: string;
  cardBorder: string;
  separator: string;
  label: string;
  value: string;
  arrow: string;
  underline: string;
  placeholder: string;
  trackOff: string;
  thumb: string;
  title: string;
  danger: string;
}

export function settingsColors(colors: ThemeColors, isDark: boolean): SettingColors {
  return {
    cardBg: isDark ? '#1A1A1A' : '#FFFFFF',
    cardBorder: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
    separator: isDark ? '#2A2A2A' : '#E0E0E0',
    label: isDark ? '#FFFFFF' : '#1A1A1A',
    value: isDark ? '#B0B0B0' : '#6A6A6A',
    arrow: isDark ? '#6A6A6A' : '#A0A0A0',
    underline: isDark ? '#2A2A2A' : '#E0E0E0',
    placeholder: isDark ? '#6A6A6A' : '#A0A0A0',
    trackOff: isDark ? '#2A2A2A' : '#E0E0E0',
    thumb: '#FFFFFF',
    title: isDark ? '#6A6A6A' : '#A0A0A0',
    danger: '#F44336',
  };
}

/** 卡片分组：左侧 2dp 紫色竖条 + 圆角 12dp 卡片 */
export function SettingsGroup({
  title,
  sc,
  bar,
  children,
  style,
}: {
  title: string;
  sc: SettingColors;
  bar: string;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={styles.groupWrap}>
      <Text style={[styles.groupTitle, { color: sc.title }]}>{title}</Text>
      <View style={[styles.group, { backgroundColor: sc.cardBg, borderColor: sc.cardBorder }, style]}>
        <View style={[styles.groupBar, { backgroundColor: bar }]} />
        {children}
      </View>
    </View>
  );
}

/** 列表行：高 48dp，内边距 16dp */
export function SettingRow({
  label,
  value,
  icon,
  iconColor,
  sc,
  onPress,
  danger,
  last,
  right,
  style,
}: {
  label: string;
  value?: string;
  icon?: AppIconName;
  iconColor?: string;
  sc: SettingColors;
  onPress?: () => void;
  danger?: boolean;
  last?: boolean;
  right?: React.ReactNode;
  style?: ViewStyle;
}) {
  const content = (
    <>
      {icon ? (
        <View style={styles.rowIcon}>
          <AppIcon name={icon} size={18} color={danger ? DANGER_COLOR : iconColor} />
        </View>
      ) : null}
      <Text style={[styles.rowLabel, { color: danger ? DANGER_COLOR : sc.label }]} numberOfLines={1}>
        {label}
      </Text>
      {value !== undefined ? (
        <Text style={[styles.rowValue, { color: sc.value }]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {right}
      {onPress ? (
        <View style={styles.rowChevron}>
          <AppIcon name="chevron-right" size={16} color={sc.arrow} />
        </View>
      ) : null}
    </>
  );
  const rowStyle = [
    styles.row,
    !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: sc.separator },
    style,
  ];
  if (onPress) {
    return (
      <Pressable style={rowStyle} onPress={onPress} android_ripple={{ color: sc.separator }}>
        {content}
      </Pressable>
    );
  }
  return <View style={rowStyle}>{content}</View>;
}

/** 下划线输入框：36dp 高，聚焦下划线变主题色，失焦自动保存 */
export function UnderlineInput({
  value,
  placeholder,
  secure,
  sc,
  focusColor,
  onChangeText,
  onCommit,
  keyboardType,
  autoCapitalize,
}: {
  value: string;
  placeholder?: string;
  secure?: boolean;
  sc: SettingColors;
  focusColor: string;
  onChangeText?: (text: string) => void;
  onCommit?: (text: string) => void;
  keyboardType?: 'default' | 'url' | 'email-address' | 'numeric';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    setText(value);
  }, [value]);

  return (
    <View style={styles.inputWrap}>
      <TextInput
        style={[styles.input, { color: sc.label }]}
        value={text}
        onChangeText={(t) => {
          setText(t);
          if (onChangeText) onChangeText(t);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (onCommit) onCommit(text.trim());
        }}
        placeholder={placeholder}
        placeholderTextColor={sc.placeholder}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
      />
      <View style={[styles.inputUnderline, { backgroundColor: focused ? focusColor : sc.underline }]} />
    </View>
  );
}

/** 自定义开关：48x26dp 轨道 + 白色滑块，200ms 动画 */
export function AnimatedToggle({
  value,
  onValueChange,
  sc,
  trackOn,
}: {
  value: boolean;
  onValueChange: (v: boolean) => void;
  sc: SettingColors;
  trackOn: string;
}) {
  const progress = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    progress.set(withTiming(value ? 1 : 0, { duration: 200, easing: Easing.inOut(Easing.ease) }));
  }, [value, progress]);

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.get(), [0, 1], [sc.trackOff, trackOn]),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(progress.get(), [0, 1], [2, 22]) }],
  }));

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      hitSlop={8}
    >
      <Animated.View style={[styles.toggleTrack, trackStyle]}>
        <Animated.View style={[styles.toggleThumb, thumbStyle]} />
      </Animated.View>
    </Pressable>
  );
}

/** 分段选择器 */
export function SegmentControl<T extends string>({
  options,
  value,
  onChange,
  activeColor,
  inactiveBg,
  textColor,
}: {
  options: Array<{ key: T; label: string }>;
  value: T;
  onChange: (key: T) => void;
  activeColor: string;
  inactiveBg: string;
  textColor: string;
}) {
  return (
    <View style={styles.segment}>
      {options.map((o) => (
        <Pressable
          key={o.key}
          style={[styles.segmentItem, { backgroundColor: value === o.key ? activeColor : inactiveBg }]}
          onPress={() => onChange(o.key)}
        >
          <Text style={[styles.segmentText, { color: value === o.key ? '#FFFFFF' : textColor }]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  groupWrap: {
    marginBottom: 12,
  },
  groupTitle: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
    marginLeft: 2,
  },
  group: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  groupBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    gap: 10,
  },
  rowIcon: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  rowValue: {
    fontSize: 14,
    maxWidth: 160,
  },
  rowChevron: {
    marginLeft: 2,
  },
  inputWrap: {
    minHeight: 36,
    justifyContent: 'flex-end',
    paddingTop: 2,
  },
  input: {
    height: 30,
    fontSize: 13,
    paddingVertical: 0,
  },
  inputUnderline: {
    height: 1,
  },
  toggleTrack: {
    width: 48,
    height: 26,
    borderRadius: 13,
    padding: 2,
  },
  toggleThumb: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  segment: {
    flexDirection: 'row',
    gap: 6,
  },
  segmentItem: {
    flex: 1,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  segmentText: {
    fontSize: 12,
    fontWeight: '600',
  },
});

// 供 SettingRow 危险行使用的红色（规范错误色）
export const DANGER_COLOR = '#F44336';
