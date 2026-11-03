package dev.fl1nt.cindl.screen

import android.content.Context
import android.graphics.Canvas
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * Draws one surface's picture, centred with its aspect kept. Touches are
 * handled in JavaScript, which maps them through the same fit.
 */
class CindlScreenView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var surface: ScreenSurface? = null

  init {
    // A LinearLayout skips onDraw unless told otherwise.
    setWillNotDraw(false)
  }

  fun attach(id: String) {
    surface?.detach(this)
    val next = ScreenSurfaces.get(id)
    surface = next
    next.attach(this)
  }

  fun detach() {
    surface?.detach(this)
    surface = null
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    surface?.draw(canvas, width, height)
  }
}
