import {
  withGradleProperties,
  type AndroidConfig,
  type ConfigPlugin,
} from 'expo/config-plugins'

type PropertiesItem = AndroidConfig.Properties.PropertiesItem

/**
 * Fail closed on Android SDK packages. With this property the Android Gradle
 * plugin never downloads a missing platform, build-tools, NDK or CMake
 * package, which would also rely on (and so use) an accepted SDK licence on
 * the build machine. A build uses only what is already installed and fails,
 * naming the missing package, otherwise. Accepting Android SDK terms is the
 * owner's decision (docs/handbook/clients/android.md).
 */
export const SDK_DOWNLOAD_PROPERTY = 'android.builder.sdkDownload'

export function disableSdkDownloads(
  properties: readonly PropertiesItem[],
): PropertiesItem[] {
  return [
    ...properties.filter(
      (item) => !(item.type === 'property' && item.key === SDK_DOWNLOAD_PROPERTY),
    ),
    {
      type: 'comment',
      value:
        'Never download Android SDK packages during a build (owner approval required).',
    },
    { type: 'property', key: SDK_DOWNLOAD_PROPERTY, value: 'false' },
  ]
}

export const withNoSdkDownloads: ConfigPlugin = (config) =>
  withGradleProperties(config, (modConfig) => {
    modConfig.modResults = disableSdkDownloads(modConfig.modResults)
    return modConfig
  })
