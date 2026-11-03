package dev.fl1nt.cindl.screen

import java.nio.ByteBuffer

/*
 * Pixel math for the agent screen's picture, free of Android types so it runs
 * on a plain JVM in CI (src/test). The direct client hands JavaScript the
 * screen's changed regions as RGBA bytes, rows top to bottom; each is clipped
 * to the screen and turned into the ARGB ints Bitmap.setPixels takes. The
 * picture is opaque: the alpha byte is ignored.
 */

/** Largest screen side painted, as the RFB client accepts it. */
const val MAX_SIDE = 8192

/** Largest screen area painted (a 64 MiB bitmap), as the RFB client caps it. */
const val MAX_PIXELS = 4096 * 4096

/** A rectangle of screen pixels. */
data class Region(val x: Int, val y: Int, val width: Int, val height: Int)

/** Where the picture is drawn inside a view: centred, its aspect kept. */
data class Fit(val left: Float, val top: Float, val width: Float, val height: Float)

/** True for a screen size this module allocates a bitmap for. */
fun validSize(width: Int, height: Int): Boolean =
  width in 1..MAX_SIDE && height in 1..MAX_SIDE && width.toLong() * height <= MAX_PIXELS

/** The part of a region inside a screen of the given size, or null when none is. */
fun clipRegion(
  x: Int,
  y: Int,
  width: Int,
  height: Int,
  screenWidth: Int,
  screenHeight: Int,
): Region? {
  if (width <= 0 || height <= 0 || screenWidth <= 0 || screenHeight <= 0) return null
  val left = maxOf(x, 0)
  val top = maxOf(y, 0)
  val right = minOf(x.toLong() + width, screenWidth.toLong())
  val bottom = minOf(y.toLong() + height, screenHeight.toLong())
  if (right <= left || bottom <= top) return null
  return Region(left, top, (right - left).toInt(), (bottom - top).toInt())
}

/**
 * Writes the `clip` part of an RGBA region into `out` as opaque ARGB ints,
 * `clip.width` per row from index 0. `rgba` holds the whole region as it
 * arrived (`regionWidth` x `regionHeight` pixels). Returns false and writes
 * nothing when the bytes are too few, `out` is too small, or `clip` is not
 * inside the region.
 */
fun regionToArgb(
  rgba: ByteBuffer,
  regionX: Int,
  regionY: Int,
  regionWidth: Int,
  regionHeight: Int,
  clip: Region,
  out: IntArray,
): Boolean {
  if (regionWidth <= 0 || regionHeight <= 0) return false
  if (rgba.limit().toLong() < regionWidth.toLong() * regionHeight * 4) return false
  if (out.size.toLong() < clip.width.toLong() * clip.height) return false
  if (clip.x < regionX || clip.y < regionY) return false
  if (clip.x + clip.width > regionX + regionWidth) return false
  if (clip.y + clip.height > regionY + regionHeight) return false
  var index = 0
  for (row in 0 until clip.height) {
    var at = ((clip.y - regionY + row) * regionWidth + (clip.x - regionX)) * 4
    for (column in 0 until clip.width) {
      val red = rgba.get(at).toInt() and 0xff
      val green = rgba.get(at + 1).toInt() and 0xff
      val blue = rgba.get(at + 2).toInt() and 0xff
      out[index] = (0xff shl 24) or (red shl 16) or (green shl 8) or blue
      index += 1
      at += 4
    }
  }
  return true
}

/** The picture's place in a view of the given size, or null when either is empty. */
fun fit(viewWidth: Float, viewHeight: Float, imageWidth: Int, imageHeight: Int): Fit? {
  if (viewWidth <= 0f || viewHeight <= 0f || imageWidth <= 0 || imageHeight <= 0) return null
  val scale = minOf(viewWidth / imageWidth, viewHeight / imageHeight)
  val width = imageWidth * scale
  val height = imageHeight * scale
  return Fit((viewWidth - width) / 2f, (viewHeight - height) / 2f, width, height)
}
