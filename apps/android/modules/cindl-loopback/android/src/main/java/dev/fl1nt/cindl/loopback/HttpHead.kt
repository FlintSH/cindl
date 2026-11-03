package dev.fl1nt.cindl.loopback

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.URLDecoder

/** Request line and Host header of one HTTP/1.x request. */
internal data class RequestHead(val method: String, val target: String, val host: String?)

/** Minimal, strict HTTP/1.x request-head parsing for the loopback callback. */
internal object HttpHead {
  const val MAX_HEAD_BYTES = 8 * 1024

  /** Reads up to the blank line that ends the head. Null when malformed, cut short or too large. */
  fun read(input: InputStream): String? {
    val buffer = ByteArrayOutputStream()
    var matched = 0
    while (buffer.size() < MAX_HEAD_BYTES) {
      val next = input.read()
      if (next < 0) return null
      buffer.write(next)
      matched =
        when {
          next == CR && (matched == 0 || matched == 2) -> matched + 1
          next == LF && (matched == 1 || matched == 3) -> matched + 1
          next == CR -> 1
          else -> 0
        }
      if (matched == 4) return buffer.toString("ISO-8859-1")
    }
    return null
  }

  fun parse(head: String): RequestHead? {
    val lines = head.split("\r\n")
    val parts = lines.firstOrNull()?.split(' ') ?: return null
    if (parts.size != 3 || !parts[2].startsWith("HTTP/1.")) return null
    val host =
      lines
        .drop(1)
        .firstOrNull { it.startsWith("host:", ignoreCase = true) }
        ?.substringAfter(':')
        ?.trim()
    return RequestHead(parts[0], parts[1], host)
  }

  /** Path of a request target, without query or fragment. */
  fun path(target: String): String = target.substringBefore('?').substringBefore('#')

  /**
   * Query parameters, decoded like the app's URLSearchParams: form encoding,
   * UTF-8, and the first value wins for a repeated name. Null when a value is
   * not valid percent-encoding.
   */
  fun queryParams(target: String): Map<String, String>? {
    val query = target.substringBefore('#').substringAfter('?', "")
    val params = LinkedHashMap<String, String>()
    if (query.isEmpty()) return params
    for (pair in query.split('&')) {
      if (pair.isEmpty()) continue
      val name = decode(pair.substringBefore('=')) ?: return null
      val value = decode(pair.substringAfter('=', "")) ?: return null
      if (!params.containsKey(name)) params[name] = value
    }
    return params
  }

  private fun decode(value: String): String? =
    try {
      URLDecoder.decode(value, "UTF-8")
    } catch (malformed: IllegalArgumentException) {
      null
    }

  private const val CR = '\r'.code
  private const val LF = '\n'.code
}
