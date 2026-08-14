import React, { useEffect, useMemo } from 'react';
import { View, Pressable, StyleSheet, Text, type ViewStyle, type DimensionValue } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  withRepeat,
  withSequence,
  withDelay,
  cancelAnimation,
  useReducedMotion,
  ReduceMotion,
  Easing,
  FadeIn,
  FadeInUp,
  SlideInLeft,
  SlideInRight,
  SlideInUp,
  FadeOutDown,
} from 'react-native-reanimated';
import type { ThemeColors } from '@/utils/theme';
import { AppIcon } from './AppIcon';

export type StepStatus = 'pending' | 'running' | 'done' | 'error';

/**
 * 低端设备 / 系统"减弱动态效果"时自动缩短时长并禁用循环动画。
 * 返回动画时长缩放系数（0 表示禁用循环类动画）。
 */
export function useMotion(): { durationScale: number; loops: boolean } {
  const reduced = useReducedMotion();
  return reduced ? { durationScale: 0.5, loops: false } : { durationScale: 1, loops: true };
}

const easeOut = Easing.out(Easing.ease);

// 入场动画预设（低端设备自动降级为快速淡入）
export function useEntry(direction: 'panel' | 'card' | 'step' | 'message') {
  const reduced = useReducedMotion();
  return useMemo(() => {
    if (reduced) {
      return { entering: FadeIn.duration(80), exiting: FadeOutDown.duration(80) } as const;
    }
    switch (direction) {
      case 'panel':
        return { entering: SlideInRight.duration(300).easing(easeOut) } as const;
      case 'card':
        return { entering: SlideInUp.duration(250).easing(easeOut) } as const;
      case 'step':
        return { entering: SlideInLeft.duration(200).easing(easeOut) } as const;
      case 'message':
        return { entering: FadeInUp.duration(200).easing(easeOut) } as const;
    }
  }, [reduced, direction]);
}

interface PressableScaleProps {
  children: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  style?: ViewStyle | ViewStyle[];
  disabled?: boolean;
  scaleTo?: number;
  hitSlop?: number | { top: number; bottom: number; left: number; right: number };
}

/** 点击按压缩放反馈（150ms 弹性回到 1.0） */
export function PressableScale({
  children,
  onPress,
  onLongPress,
  delayLongPress,
  style,
  disabled,
  scaleTo = 0.97,
  hitSlop,
}: PressableScaleProps) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));
  return (
    <Animated.View style={[style, animatedStyle]}>
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={delayLongPress}
        disabled={disabled}
        hitSlop={hitSlop}
        onPressIn={() => {
          scale.set(withSpring(scaleTo, { damping: 18, stiffness: 320, mass: 0.4 }));
        }}
        onPressOut={() => {
          scale.set(withSpring(1, { damping: 14, stiffness: 260, mass: 0.4 }));
        }}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

const STATUS_COLORS: Record<StepStatus, string> = {
  done: '#4CAF50',
  running: '#555555',
  pending: '#6A6A6A',
  error: '#F44336',
};

/**
 * 步骤状态图标：
 * - 等待：静态圆点
 * - 进行中：旋转加载圈 + 脉动呼吸
 * - 完成：-180°→0° 旋转 + 绿色脉冲
 * - 失败：抖动 + 红色脉冲
 */
export function StepStatusIcon({ status, size = 14 }: { status: StepStatus; size?: number }) {
  const { loops } = useMotion();
  const rotate = useSharedValue(0);
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const opacity = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.get(),
    transform: [
      { rotate: `${rotate.get()}deg` },
      { scale: scale.get() },
      { translateX: translateX.get() },
    ],
  }));

  useEffect(() => {
    if (status === 'running') {
      if (loops) {
        rotate.set(withRepeat(withTiming(360, { duration: 1100, easing: Easing.linear }), -1));
        opacity.set(
          withRepeat(withSequence(withTiming(0.6, { duration: 600 }), withTiming(1, { duration: 600 })), -1)
        );
      } else {
        opacity.set(1);
      }
      scale.set(1);
      translateX.set(0);
      return;
    }

    cancelAnimation(rotate);
    cancelAnimation(opacity);
    rotate.set(0);
    opacity.set(1);

    if (status === 'done') {
      rotate.set(
        withSequence(withTiming(-180, { duration: 0 }), withSpring(0, { damping: 16, stiffness: 220, mass: 0.6 }))
      );
      scale.set(withSequence(withTiming(1.25, { duration: 150 }), withSpring(1, { damping: 12, stiffness: 200 })));
      translateX.set(0);
    } else if (status === 'error') {
      translateX.set(
        withSequence(
          withTiming(-4, { duration: 50 }),
          withTiming(4, { duration: 50 }),
          withTiming(-3, { duration: 50 }),
          withTiming(3, { duration: 50 }),
          withTiming(0, { duration: 50 })
        )
      );
      scale.set(withSequence(withTiming(1.2, { duration: 100 }), withSpring(1, { damping: 10, stiffness: 180 })));
    } else {
      scale.set(1);
      translateX.set(0);
    }
  }, [status, loops, rotate, opacity, scale, translateX]);

  if (status === 'pending') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View
          style={{
            width: size * 0.7,
            height: size * 0.7,
            borderRadius: size,
            borderWidth: 1.5,
            borderColor: STATUS_COLORS.pending,
          }}
        />
      </View>
    );
  }

  return (
    <Animated.View style={animatedStyle}>
      {status === 'running' ? (
        <AppIcon name="loader" size={size} color={STATUS_COLORS.running} />
      ) : status === 'done' ? (
        <AppIcon name="check-circle" size={size} color={STATUS_COLORS.done} />
      ) : (
        <AppIcon name="x-circle" size={size} color={STATUS_COLORS.error} />
      )}
    </Animated.View>
  );
}

/** 进度条平滑填充（400ms ease-in-out） */
export function AnimatedProgressBar({
  progress,
  color,
  trackColor,
  height = 6,
  style,
}: {
  progress: number;
  color: string;
  trackColor: string;
  height?: number;
  style?: ViewStyle | ViewStyle[];
}) {
  const width = useSharedValue(Math.max(4, progress * 100));
  const animatedStyle = useAnimatedStyle(() => ({
    width: `${width.get()}%`,
  }));

  useEffect(() => {
    width.set(
      withTiming(Math.max(4, progress * 100), {
        duration: 400,
        easing: Easing.inOut(Easing.ease),
        reduceMotion: ReduceMotion.System,
      })
    );
  }, [progress, width]);

  return (
    <View style={[{ height, borderRadius: height / 2, backgroundColor: trackColor, overflow: 'hidden' }, style]}>
      <Animated.View
        style={[{ height: '100%', borderRadius: height / 2, backgroundColor: color }, animatedStyle]}
      />
    </View>
  );
}

/** Agent 思考中：三个点依次出现（1.2s 循环） */
export function ThinkingDots({ color, size = 5, gap = 5 }: { color: string; size?: number; gap?: number }) {
  const { loops } = useMotion();
  const a = useSharedValue(0.2);
  const b = useSharedValue(0.2);
  const c = useSharedValue(0.2);

  useEffect(() => {
    if (!loops) {
      a.value = 0.8;
      b.value = 0.8;
      c.value = 0.8;
      return;
    }
    const seq = () =>
      withRepeat(withSequence(withTiming(1, { duration: 400 }), withTiming(0.2, { duration: 400 })), -1);
    a.set(seq());
    b.set(withDelay(150, seq()));
    c.set(withDelay(300, seq()));
    return () => {
      cancelAnimation(a);
      cancelAnimation(b);
      cancelAnimation(c);
    };
  }, [loops, a, b, c]);

  const s1 = useAnimatedStyle(() => ({ opacity: a.get() }));
  const s2 = useAnimatedStyle(() => ({ opacity: b.get() }));
  const s3 = useAnimatedStyle(() => ({ opacity: c.get() }));

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap }}>
      {[s1, s2, s3].map((s, i) => (
        <Animated.View
          key={i}
          style={[
            { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
            s,
          ]}
        />
      ))}
    </View>
  );
}

/** 工具执行中：灰色旋转加载圈（线性风格） */
export function ToolSpinner({ size = 14, color = '#555555' }: { size?: number; color?: string }) {
  const { loops } = useMotion();
  const rotate = useSharedValue(0);

  useEffect(() => {
    if (loops) {
      rotate.set(
        withRepeat(withTiming(360, { duration: 900, easing: Easing.linear, reduceMotion: ReduceMotion.System }), -1)
      );
    }
    return () => cancelAnimation(rotate);
  }, [loops, rotate]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotate.get()}deg` }],
  }));

  return (
    <Animated.View style={animatedStyle}>
      <AppIcon name="loader" size={size} color={color} />
    </Animated.View>
  );
}

/** 骨架屏闪烁（1.5s 循环） */
export function Skeleton({
  width,
  height,
  colors,
  radius = 8,
  style,
}: {
  width: DimensionValue;
  height: number;
  colors: ThemeColors;
  radius?: number;
  style?: ViewStyle | ViewStyle[];
}) {
  const { loops } = useMotion();
  const opacity = useSharedValue(0.5);

  useEffect(() => {
    if (loops) {
      opacity.set(
        withRepeat(withSequence(withTiming(1, { duration: 750 }), withTiming(0.5, { duration: 750 })), -1)
      );
    }
    return () => cancelAnimation(opacity);
  }, [loops, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius, backgroundColor: colors.bgInput },
        animatedStyle,
        style,
      ]}
    />
  );
}

/** 任务完成底部弹窗：🎉 弹性弹出，2s 后自动淡出 */
export function CompletionToast({
  show,
  // eslint-disable-next-line forbidEmoji/no-emoji -- 用户明确要求完成弹窗使用 🎉
  text = '🎉 已完成！',
  colors,
}: {
  show: boolean;
  text?: string;
  colors: ThemeColors;
}) {
  const scale = useSharedValue(0.6);
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (show) {
      scale.set(withSpring(1, { damping: 9, stiffness: 180, mass: 0.7 }));
      opacity.set(withTiming(1, { duration: 150 }));
      const timer = setTimeout(() => {
        opacity.set(withTiming(0, { duration: 400 }));
        scale.set(withTiming(0.85, { duration: 400 }));
      }, 2000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [show, scale, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.get(),
    transform: [{ scale: scale.get() }],
  }));

  return (
    <View
      pointerEvents="none"
      style={[styles.toastWrap, show ? undefined : styles.toastHidden]}
    >
      <Animated.View
        style={[
          styles.toast,
          { backgroundColor: colors.bgCard, borderColor: colors.border },
          animatedStyle,
        ]}
      >
        <Text style={{ color: colors.textPrimary, fontSize: 15, fontWeight: '600' }}>{text}</Text>
      </Animated.View>
    </View>
  );
}


const styles = StyleSheet.create({
  toastWrap: {
    position: 'absolute',
    bottom: 24,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 50,
  },
  toastHidden: {
    opacity: 0,
  },
  toast: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 24,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
