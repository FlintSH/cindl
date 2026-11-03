import type { ConfigContext, ExpoConfig } from 'expo/config'
import { DEMO_PRODUCT_NAME } from '@cindl/contracts'
import { nativeFontFiles, themes } from '@cindl/tokens'
import { withNetworkSecurity } from './plugins/withNetworkSecurity.ts'
import { withNoBackups } from './plugins/withNoBackups.ts'
import { withNoSdkDownloads } from './plugins/withNoSdkDownloads.ts'

/**
 * Expo app config for the native Android app. `android/` is generated from
 * this file by `expo prebuild` (Continuous Native Generation) and is never
 * committed. See docs/handbook/clients/android.md.
 */
const fontsDir = '../../packages/tokens/fonts'

export default ({ config }: ConfigContext): ExpoConfig =>
  withNoSdkDownloads(
    withNoBackups(
      withNetworkSecurity({
        ...config,
        // A demo package carries its flavour in its name as well as in the UI (ADR 0011).
        name: process.env.EXPO_PUBLIC_CINDL_DEMO === '1' ? DEMO_PRODUCT_NAME : 'Cindl',
        slug: 'cindl',
        version: '0.1.0',
        description: 'A calm, cross-device home for a self-hosted Hermes agent.',
        platforms: ['android'],
        orientation: 'default',
        userInterfaceStyle: 'automatic',
        // Root view colour behind React content (expo-system-ui); the app updates it per theme.
        backgroundColor: themes.light.canvas,
        icon: './assets/icon.png',
        android: {
          package: 'dev.fl1nt.cindl',
          versionCode: 1,
          adaptiveIcon: {
            foregroundImage: './assets/adaptive-icon.png',
            monochromeImage: './assets/adaptive-icon-monochrome.png',
            backgroundColor: themes.dark.surface,
          },
          // INTERNET only. Expo's template defaults (storage, overlay, vibrate) are removed.
          permissions: ['android.permission.INTERNET'],
          blockedPermissions: [
            'android.permission.READ_EXTERNAL_STORAGE',
            'android.permission.WRITE_EXTERNAL_STORAGE',
            'android.permission.SYSTEM_ALERT_WINDOW',
            'android.permission.VIBRATE',
            'android.permission.USE_BIOMETRIC',
            'android.permission.USE_FINGERPRINT',
            'android.permission.RECORD_AUDIO',
            'android.permission.ACCESS_NETWORK_STATE',
          ],
          // Conversation state and Keystore-bound secrets never go to cloud or device-transfer backups.
          allowBackup: false,
          softwareKeyboardLayoutMode: 'resize',
        },
        plugins: [
          ['expo-font', { fonts: nativeFontFiles.map((file) => `${fontsDir}/${file}`) }],
          [
            'expo-splash-screen',
            {
              backgroundColor: themes.light.canvas,
              image: './assets/splash-icon-light.png',
              imageWidth: 88,
              dark: {
                backgroundColor: themes.dark.canvas,
                image: './assets/splash-icon-dark.png',
              },
            },
          ],
          // allowBackup is false, so no backup rules are needed for secure storage.
          ['expo-secure-store', { configureAndroidBackup: false }],
        ],
      }),
    ),
  )
