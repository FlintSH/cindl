package dev.fl1nt.cindl.screen

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import java.nio.ByteBuffer

/**
 * One screen's newest pixels: a single Bitmap of the screen's size and no
 * history, so memory stays bounded. JavaScript paints it on its own thread and
 * views draw it on the UI thread, under one lock. Frames, input and the screen
 * socket's URL never reach this class, and nothing here is logged.
 */
internal class ScreenSurface {
  private val lock = Any()
  private var bitmap: Bitmap? = null
  private var scratch = IntArray(0)
  private val views = LinkedHashSet<CindlScreenView>()
  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val target = RectF()

  /** Sizes the picture, starting black; false (nothing allocated) when out of bounds. */
  fun resize(width: Int, height: Int): Boolean {
    if (!validSize(width, height)) return false
    synchronized(lock) {
      val current = bitmap
      if (current == null || current.width != width || current.height != height) {
        val next = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        next.eraseColor(Color.BLACK)
        bitmap = next
        scratch = IntArray(0)
        current?.recycle()
      }
    }
    invalidateViews()
    return true
  }

  /** Paints one RGBA region, read in place from JavaScript's memory during this call. */
  fun paint(x: Int, y: Int, width: Int, height: Int, rgba: ByteBuffer): Boolean {
    synchronized(lock) {
      val picture = bitmap ?: return false
      val clip = clipRegion(x, y, width, height, picture.width, picture.height) ?: return false
      val count = clip.width * clip.height
      if (scratch.size < count) scratch = IntArray(count)
      if (!regionToArgb(rgba, x, y, width, height, clip, scratch)) return false
      picture.setPixels(scratch, 0, clip.width, clip.x, clip.y, clip.width, clip.height)
    }
    invalidateViews()
    return true
  }

  fun draw(canvas: Canvas, viewWidth: Int, viewHeight: Int) {
    synchronized(lock) {
      val picture = bitmap ?: return
      val placed = fit(viewWidth.toFloat(), viewHeight.toFloat(), picture.width, picture.height) ?: return
      target.set(placed.left, placed.top, placed.left + placed.width, placed.top + placed.height)
      canvas.drawBitmap(picture, null, target, paint)
    }
  }

  fun attach(view: CindlScreenView) {
    synchronized(views) { views.add(view) }
    view.postInvalidate()
  }

  fun detach(view: CindlScreenView) {
    synchronized(views) { views.remove(view) }
  }

  fun release() {
    synchronized(lock) {
      bitmap?.recycle()
      bitmap = null
      scratch = IntArray(0)
    }
    invalidateViews()
  }

  private fun invalidateViews() {
    val attached = synchronized(views) { views.toList() }
    for (view in attached) view.postInvalidate()
  }
}

/** Surfaces by the id JavaScript gives each screen view; released when that view goes. */
internal object ScreenSurfaces {
  private val surfaces = HashMap<String, ScreenSurface>()

  @Synchronized
  fun get(id: String): ScreenSurface = surfaces.getOrPut(id) { ScreenSurface() }

  @Synchronized
  fun release(id: String) {
    surfaces.remove(id)?.release()
  }
}
