import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useThemeColors } from '@/components/ThemeProvider';

export type RoundedAlertButtonStyle = 'default' | 'cancel' | 'destructive';

export interface RoundedAlertButton {
  text: string;
  style?: RoundedAlertButtonStyle;
  onPress?: () => void;
}

interface RoundedAlertRequest {
  id: number;
  title: string;
  message?: string;
  buttons: RoundedAlertButton[];
}

type AlertListener = (request: RoundedAlertRequest) => void;

let nextAlertId = 1;
let alertListener: AlertListener | null = null;

export function showRoundedAlert(
  title: string,
  message?: string,
  buttons?: RoundedAlertButton[]
) {
  const request: RoundedAlertRequest = {
    id: nextAlertId++,
    title,
    message,
    buttons: buttons?.length ? buttons : [{ text: '好的' }],
  };
  alertListener?.(request);
}

export function showRoundedMessage(message: string) {
  showRoundedAlert('提示', message);
}

function RoundedAlertDialog({ request, onClose }: {
  request: RoundedAlertRequest;
  onClose: () => void;
}) {
  const { colors } = useThemeColors();
  const horizontalButtons = request.buttons.length === 2;

  const handlePress = (button: RoundedAlertButton) => {
    onClose();
    button.onPress?.();
  };

  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.card, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
          <ScrollView
            style={styles.contentScroll}
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
          >
            <Text style={[styles.title, { color: colors.textPrimary }]}>{request.title}</Text>
            {request.message ? (
              <Text style={[styles.message, { color: colors.textSecondary }]}>{request.message}</Text>
            ) : null}
          </ScrollView>
          <View style={[styles.footer, horizontalButtons && styles.footerHorizontal]}>
            {request.buttons.map((button) => {
              const isDestructive = button.style === 'destructive';
              const isCancel = button.style === 'cancel';
              return (
                <Pressable
                  key={`${request.id}-${button.text}`}
                  style={[
                    styles.button,
                    horizontalButtons && styles.buttonHorizontal,
                    isCancel && { backgroundColor: colors.bgInput },
                    !isCancel && { backgroundColor: colors.primary },
                  ]}
                  onPress={() => handlePress(button)}
                  android_ripple={{ color: colors.separator }}
                >
                  <Text
                    style={[
                      styles.buttonText,
                      { color: isCancel ? colors.textPrimary : '#FFFFFF' },
                      isDestructive && { color: isCancel ? colors.danger : '#FFFFFF' },
                    ]}
                    numberOfLines={1}
                  >
                    {button.text}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function RoundedAlertHost() {
  const [request, setRequest] = useState<RoundedAlertRequest | null>(null);

  useEffect(() => {
    alertListener = setRequest;
    return () => {
      alertListener = null;
    };
  }, []);

  if (!request) return null;
  return <RoundedAlertDialog request={request} onClose={() => setRequest(null)} />;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.48)',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    maxHeight: '72%',
    borderRadius: 22,
    borderWidth: 1,
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.22,
    shadowRadius: 36,
    elevation: 16,
  },
  contentScroll: {
    flexGrow: 0,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 14,
  },
  title: {
    fontSize: 17,
    lineHeight: 23,
    fontWeight: '700',
    textAlign: 'center',
  },
  message: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  footer: {
    gap: 10,
    padding: 14,
  },
  footerHorizontal: {
    flexDirection: 'row',
  },
  button: {
    minHeight: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonHorizontal: {
    flex: 1,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
