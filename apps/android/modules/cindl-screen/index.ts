import { requireNativeView, requireOptionalNativeModule } from 'expo'
import type { ComponentType } from 'react'
import type { ViewProps } from 'react-native'

/**
 * The Kotlin picture of the agent screen
 * (android/src/main/java/dev/fl1nt/cindl/screen). Each screen view has a
 * surface: one bitmap of the screen's size, painted region by region. A
 * region's bytes are read in place through JSI, not copied across the bridge.
 */
export interface CindlScreenNative {
  /** Sizes a surface's picture, black at first; false when the size is out of bounds. */
  resize(surface: string, width: number, height: number): boolean
  /** Paints one RGBA region (rows top to bottom); false when it lies off the picture. */
  paint(
    surface: string,
    x: number,
    y: number,
    width: number,
    height: number,
    rgba: Uint8Array,
  ): boolean
  /** Frees a surface's bitmap. */
  release(surface: string): void
}

export type ScreenSurfaceProps = ViewProps & { surface: string }

/** Null when the native module is not linked into this build. */
export const screenNative = requireOptionalNativeModule<CindlScreenNative>('CindlScreen')

/** Draws one surface's picture, centred with its aspect kept. */
export const ScreenSurfaceView: ComponentType<ScreenSurfaceProps> | undefined =
  screenNative ? requireNativeView<ScreenSurfaceProps>('CindlScreen') : undefined
