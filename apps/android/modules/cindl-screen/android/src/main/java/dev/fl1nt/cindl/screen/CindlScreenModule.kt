package dev.fl1nt.cindl.screen

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array

/**
 * The agent screen's picture (ADR 0012). JavaScript keeps the RFB session
 * (client-core) and passes each changed region here as a typed array, which
 * is read in place through JSI: no base64 and no copy across the bridge.
 */
class CindlScreenModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CindlScreen")

    /** Sizes a surface's picture; false when the size is out of bounds. */
    Function("resize") { surface: String, width: Int, height: Int ->
      ScreenSurfaces.get(surface).resize(width, height)
    }

    /** Paints one RGBA region (rows top to bottom) onto a surface. */
    Function("paint") { surface: String, x: Int, y: Int, width: Int, height: Int, rgba: Uint8Array ->
      ScreenSurfaces.get(surface).paint(x, y, width, height, rgba.toDirectBuffer())
    }

    /** Frees a surface's bitmap when its view goes away. */
    Function("release") { surface: String ->
      ScreenSurfaces.release(surface)
    }

    View(CindlScreenView::class) {
      Prop("surface") { view: CindlScreenView, surface: String ->
        view.attach(surface)
      }

      OnViewDestroys { view: CindlScreenView ->
        view.detach()
      }
    }
  }
}
