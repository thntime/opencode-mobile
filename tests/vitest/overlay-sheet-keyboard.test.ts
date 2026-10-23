import { describe, expect, it } from 'vitest';

import { loadTs } from '../helpers/runtime.mjs';

type Element = { type: unknown; props: Record<string, any> };
const element = (type: unknown, props: Element['props']) => ({ type, props });
const flatten = (style: any): Record<string, any> => Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten)) : style || {};

// Mutable so one module instance can be rendered per platform, matching the
// component reading `Platform.OS` at render time.
const platform = { OS: 'ios' };

const { OverlaySheet } = await loadTs('components/ui/overlay-sheet.tsx', {
  '@/providers/workspace-context': { WorkspaceScope: 'WorkspaceScope', WorkspaceScopeContext: {} },
  react: { useContext: () => undefined },
  'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
  'react-native': {
    Platform: platform,
    StyleSheet: {
      create: (styles: unknown) => styles,
      absoluteFill: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 },
    },
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    View: 'View',
    useWindowDimensions: () => ({ height: 800 }),
  },
  'react-native-gesture-handler': {
    Gesture: {
      Pan: () => ({
        enabled() { return this; },
        activeOffsetY() { return this; },
        onUpdate() { return this; },
        onEnd() { return this; },
      }),
    },
    GestureDetector: 'GestureDetector',
  },
  'react-native-paper': { Portal: 'Portal', Icon: 'Icon', Text: 'Text' },
  'react-native-reanimated': {
    __esModule: true,
    default: { View: 'View' },
    runOnJS: (fn: () => void) => fn,
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: unknown) => ({ value }),
    withSpring: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 10, bottom: 20 }) },
  'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
  '@/hooks/use-update-blocker': { useUpdateBlocker: () => {} },
  '@/constants/theme': { Colors: { light: {} } },
  '@/hooks/use-color-scheme': { useColorScheme: () => 'light' },
  '@/hooks/use-dismiss-on-back': { useDismissOnBack: () => {} },
  './use-swipe-dismiss': {
    useSwipeDismiss: () => ({ pan: {}, sheetStyle: {}, backdropStyle: {}, handleSheetLayout: () => {} }),
  },
});

function frame(os: string, props: Record<string, unknown> = {}) {
  platform.OS = os;
  const root = OverlaySheet({ visible: true, title: 'Unlock', testID: 'sheet', children: 'Content', ...props });
  return root.props.children as Element;
}

describe('OverlaySheet keyboard avoidance', () => {
  it('shrinks the container height on Android so the sheet sits above the keyboard', () => {
    expect(frame('android').props.behavior).toBe('height');
  });

  it.each(['ios', 'web'])('pads the container on %s', (os) => {
    expect(frame(os).props.behavior).toBe('padding');
  });

  it('keeps the bottom-anchored absolute overlay structure', () => {
    const keyboardFrame = frame('android');
    expect(keyboardFrame.type).toBe('KeyboardAvoidingView');
    expect(flatten(keyboardFrame.props.style)).toMatchObject({
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      justifyContent: 'flex-end',
      paddingTop: 74,
    });
  });

  it('keeps the compact paddingTop cap above the keyboard-avoiding frame', () => {
    expect(flatten(frame('android', { compact: true }).props.style).paddingTop).toBe(360);
    expect(flatten(frame('ios', { compact: true }).props.style).paddingTop).toBe(360);
  });
});
