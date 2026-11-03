package dev.fl1nt.cindl.loopback

import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.security.MessageDigest

/** How one sign-in attempt's listener ended. */
sealed class LoopbackOutcome {
  /** The browser delivered the callback; [target] is its path and query (holds the one-time code). */
  data class Received(val target: String) : LoopbackOutcome()

  data class Failed(val code: String, val message: String) : LoopbackOutcome()
}

/**
 * The RFC 8252 loopback leg of the Hermes native sign-in. It listens on
 * 127.0.0.1 only, on an ephemeral port, for one `GET /callback` whose `state`
 * matches the attempt (compared in constant time) and whose Host is this
 * listener. That request gets a static page and ends the attempt; anything
 * else gets an error page and the listener keeps waiting until it succeeds,
 * is cancelled, or its deadline passes. It never logs: the callback carries a
 * one-time authorization code.
 */
class LoopbackListener(
  timeoutMillis: Long,
  private val clock: () -> Long = System::currentTimeMillis,
) {
  private val server =
    ServerSocket(0, BACKLOG, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
  private val deadline = clock() + timeoutMillis
  private val lock = Any()
  private var expectedState: String? = null
  private var finishing = false
  private var outcome: LoopbackOutcome? = null
  private val waiters = mutableListOf<(LoopbackOutcome) -> Unit>()

  val port: Int = server.localPort

  /** Accepts connections on a background daemon thread. */
  fun start(): LoopbackListener {
    val worker = Thread({ serve() }, "cindl-loopback")
    worker.isDaemon = true
    worker.start()
    return this
  }

  /** Sets the `state` this attempt accepts. Callbacks before this get 503 and are ignored. */
  fun arm(state: String) {
    require(state.isNotEmpty()) { "state must not be empty" }
    synchronized(lock) { expectedState = state }
  }

  /** Calls [listener] once with the outcome, immediately if the attempt already ended. */
  fun onOutcome(listener: (LoopbackOutcome) -> Unit) {
    val done = synchronized(lock) { outcome ?: run { waiters.add(listener); null } }
    if (done != null) listener(done)
  }

  val outcomeOrNull: LoopbackOutcome?
    get() = synchronized(lock) { outcome }

  fun cancel() = finish(LoopbackOutcome.Failed(CANCELLED, "Sign-in was cancelled."))

  private val isFinishing: Boolean
    get() = synchronized(lock) { finishing }

  private fun serve() {
    try {
      while (!isFinishing) {
        val remaining = deadline - clock()
        if (remaining <= 0) {
          finish(LoopbackOutcome.Failed(TIMEOUT, "The browser did not return to Cindl in time."))
          return
        }
        server.soTimeout = remaining.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        val socket =
          try {
            server.accept()
          } catch (timeout: SocketTimeoutException) {
            continue
          } catch (closed: SocketException) {
            if (isFinishing) return
            throw closed
          }
        // One misbehaving connection (closed early, reset, too slow) never ends the attempt.
        try {
          socket.use { handle(it) }
        } catch (dropped: IOException) {
          continue
        }
      }
    } catch (error: IOException) {
      finish(LoopbackOutcome.Failed(IO, "The sign-in listener stopped unexpectedly."))
    } finally {
      closeQuietly()
    }
  }

  private fun handle(socket: Socket) {
    socket.soTimeout = READ_TIMEOUT_MILLIS
    val out = socket.getOutputStream()
    val head =
      try {
        HttpHead.read(socket.getInputStream())?.let(HttpHead::parse)
      } catch (timeout: SocketTimeoutException) {
        null
      }
    if (head == null) return respond(out, 400, "Bad Request", Pages.BAD_REQUEST)
    if (head.method != "GET") return respond(out, 405, "Method Not Allowed", Pages.BAD_REQUEST)
    if (head.host != "127.0.0.1:$port") return respond(out, 400, "Bad Request", Pages.BAD_REQUEST)
    if (HttpHead.path(head.target) != CALLBACK_PATH)
      return respond(out, 404, "Not Found", Pages.NOT_FOUND)
    val expected = synchronized(lock) { expectedState }
    if (expected == null) return respond(out, 503, "Service Unavailable", Pages.NOT_READY)
    val params = HttpHead.queryParams(head.target)
    val state = params?.get("state")
    if (state == null || !sameSecret(state, expected))
      return respond(out, 400, "Bad Request", Pages.STATE_MISMATCH)
    // Record the callback before answering: a browser that drops the response must not lose it.
    finish(LoopbackOutcome.Received(head.target))
    try {
      respond(out, 200, "OK", if (params?.containsKey("error") == true) Pages.PROVIDER_ERROR else Pages.DONE)
    } catch (dropped: IOException) {
      // The browser went away; the attempt already has its callback.
    }
  }

  private fun respond(out: OutputStream, status: Int, reason: String, page: String) {
    val body = page.toByteArray(Charsets.UTF_8)
    val headers =
      "HTTP/1.1 $status $reason\r\n" +
        "Content-Type: text/html; charset=utf-8\r\n" +
        "Content-Length: ${body.size}\r\n" +
        "Cache-Control: no-store\r\n" +
        "Referrer-Policy: no-referrer\r\n" +
        "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n" +
        "X-Content-Type-Options: nosniff\r\n" +
        "Connection: close\r\n\r\n"
    out.write(headers.toByteArray(Charsets.ISO_8859_1))
    out.write(body)
    out.flush()
  }

  private fun finish(result: LoopbackOutcome) {
    synchronized(lock) {
      if (finishing) return
      finishing = true
    }
    // Close first, so no connection is accepted once the outcome is published.
    closeQuietly()
    val notify =
      synchronized(lock) {
        outcome = result
        waiters.toList().also { waiters.clear() }
      }
    for (waiter in notify) waiter(result)
  }

  private fun closeQuietly() {
    try {
      server.close()
    } catch (ignored: IOException) {
      // Already closed.
    }
  }

  companion object {
    const val CALLBACK_PATH = "/callback"
    const val TIMEOUT = "ERR_LOOPBACK_TIMEOUT"
    const val CANCELLED = "ERR_LOOPBACK_CANCELLED"
    const val IO = "ERR_LOOPBACK_IO"
    private const val BACKLOG = 4
    /** A browser sends its request at once; anything slower is dropped so it cannot stall the attempt. */
    private const val READ_TIMEOUT_MILLIS = 2_000

    internal fun sameSecret(a: String, b: String): Boolean =
      MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))
  }
}

/** Static pages served to the system browser: no scripts, no remote resources. */
internal object Pages {
  private fun page(title: String, body: String) =
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<meta name=\"color-scheme\" content=\"light dark\"><title>Cindl</title>" +
      "<style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.5;max-width:32rem}</style>" +
      "</head><body><h1>$title</h1><p>$body</p></body></html>"

  val DONE = page("Signed in", "Cindl received your sign-in. Close this tab to return to Cindl.")
  val PROVIDER_ERROR =
    page("Sign-in did not finish", "Hermes reported a problem. Close this tab and try again in Cindl.")
  val STATE_MISMATCH =
    page("Not this sign-in", "This link does not belong to the sign-in Cindl started. Nothing was done.")
  val NOT_READY = page("Not ready", "Cindl is not waiting for a sign-in yet.")
  val NOT_FOUND = page("Not found", "Cindl only listens for its sign-in callback here.")
  val BAD_REQUEST = page("Bad request", "Cindl could not read this request.")
}
