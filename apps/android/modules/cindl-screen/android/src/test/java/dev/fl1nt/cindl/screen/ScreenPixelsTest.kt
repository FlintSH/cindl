package dev.fl1nt.cindl.screen

import java.nio.ByteBuffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenPixelsTest {
  /** RGBA bytes for 0xRRGGBB pixels, with an alpha byte the picture ignores. */
  private fun rgba(vararg pixels: Int): ByteBuffer {
    val bytes = ByteArray(pixels.size * 4)
    pixels.forEachIndexed { i, pixel ->
      bytes[i * 4] = (pixel shr 16 and 0xff).toByte()
      bytes[i * 4 + 1] = (pixel shr 8 and 0xff).toByte()
      bytes[i * 4 + 2] = (pixel and 0xff).toByte()
      bytes[i * 4 + 3] = 7
    }
    return ByteBuffer.wrap(bytes)
  }

  private fun argb(rgb: Int) = (0xff shl 24) or rgb

  @Test
  fun convertsRgbaRegionsToOpaqueArgb() {
    // A 2x2 region at (0, 0): the desktop teal and the demo's orange marker.
    val out = IntArray(4)
    val ok = regionToArgb(rgba(0x2f5d62, 0xe67828, 0x000000, 0xffffff), 0, 0, 2, 2, Region(0, 0, 2, 2), out)
    assertTrue(ok)
    assertArrayEquals(intArrayOf(argb(0x2f5d62), argb(0xe67828), argb(0x000000), argb(0xffffff)), out)
  }

  @Test
  fun clipsRegionsToTheScreen() {
    assertEquals(Region(0, 0, 4, 3), clipRegion(0, 0, 4, 3, 640, 400))
    assertEquals(Region(638, 398, 2, 2), clipRegion(638, 398, 10, 10, 640, 400))
    assertEquals(Region(0, 0, 2, 3), clipRegion(-2, -1, 4, 4, 640, 400))
    assertNull(clipRegion(640, 0, 4, 4, 640, 400))
    assertNull(clipRegion(0, 0, 0, 4, 640, 400))
    // Huge coordinates do not overflow into a valid region.
    assertNull(clipRegion(Int.MAX_VALUE, 0, Int.MAX_VALUE, 1, 640, 400))
  }

  @Test
  fun convertsOnlyTheClippedPartOfARegion() {
    // A 3x2 region at (1, 1), of which only its right 2x1 corner is asked for.
    val bytes = rgba(0x010101, 0x020202, 0x030303, 0x040404, 0x050505, 0x060606)
    val out = IntArray(2)
    assertTrue(regionToArgb(bytes, 1, 1, 3, 2, Region(2, 2, 2, 1), out))
    assertArrayEquals(intArrayOf(argb(0x050505), argb(0x060606)), out)
  }

  @Test
  fun refusesTooFewBytesOrAClipOutsideTheRegion() {
    val out = IntArray(4)
    assertFalse(regionToArgb(rgba(0x010101), 0, 0, 2, 2, Region(0, 0, 2, 2), out))
    assertFalse(regionToArgb(rgba(1, 2, 3, 4), 0, 0, 2, 2, Region(1, 1, 2, 2), out))
    assertFalse(regionToArgb(rgba(1, 2, 3, 4), 0, 0, 2, 2, Region(0, 0, 2, 2), IntArray(3)))
    assertArrayEquals(IntArray(4), out)
  }

  @Test
  fun fitsThePictureCentredWithItsAspect() {
    // A 640x400 screen in a 1000x1000 view: full width, centred vertically.
    assertEquals(Fit(0f, 187.5f, 1000f, 625f), fit(1000f, 1000f, 640, 400))
    // In a tall-enough exact-aspect view it fills the view.
    assertEquals(Fit(0f, 0f, 1280f, 800f), fit(1280f, 800f, 1280, 800))
    assertNull(fit(0f, 100f, 640, 400))
  }

  @Test
  fun boundsTheScreenArea() {
    assertTrue(validSize(1280, 800))
    assertTrue(validSize(4096, 4096))
    assertFalse(validSize(8192, 8192))
    assertFalse(validSize(0, 800))
    assertFalse(validSize(8193, 10))
  }
}
