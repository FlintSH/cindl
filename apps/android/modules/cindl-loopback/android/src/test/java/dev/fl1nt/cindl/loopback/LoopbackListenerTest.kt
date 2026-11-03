package dev.fl1nt.cindl.loopback

import java.io.ByteArrayInputStream
import java.net.ConnectException
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class LoopbackListenerTest {
  private val listeners = mutableListOf<LoopbackListener>()

  @After
  fun cancelAll() = listeners.forEach { it.cancel() }

  private fun listener(timeoutMillis: Long = 10_000): LoopbackListener =
    LoopbackListener(timeoutMillis).start().also { listeners.add(it) }

  /** Sends one raw HTTP request to 127.0.0.1 and returns the status line. */
  private fun request(port: Int, head: String): String =
    Socket(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), port).use { socket ->
      socket.soTimeout = 5_000
      socket.getOutputStream().write(head.toByteArray(Charsets.ISO_8859_1))
      socket.getOutputStream().flush()
      socket.getInputStream().bufferedReader(Charsets.ISO_8859_1).readLine() ?: ""
    }

  private fun get(listener: LoopbackListener, target: String, host: String = "127.0.0.1:${listener.port}") =
    request(listener.port, "GET $target HTTP/1.1\r\nHost: $host\r\nConnection: close\r\n\r\n")

  private fun awaitOutcome(listener: LoopbackListener): LoopbackOutcome {
    val latch = CountDownLatch(1)
    var result: LoopbackOutcome? = null
    listener.onOutcome {
      result = it
      latch.countDown()
    }
    assertTrue("listener did not finish", latch.await(5, TimeUnit.SECONDS))
    return result!!
  }

  @Test
  fun deliversTheMatchingCallbackOnceAndCloses() {
    val listener = listener()
    listener.arm("st4te_value-1")
    assertEquals("HTTP/1.1 200 OK", get(listener, "/callback?code=abc&state=st4te_value-1"))
    assertEquals(
      LoopbackOutcome.Received("/callback?code=abc&state=st4te_value-1"),
      awaitOutcome(listener),
    )
    try {
      get(listener, "/callback?code=again&state=st4te_value-1")
      fail("listener should be closed after one callback")
    } catch (expected: ConnectException) {
      // Closed: a second callback cannot be delivered.
    }
  }

  @Test
  fun refusesWrongStateAndKeepsWaiting() {
    val listener = listener()
    listener.arm("expected")
    assertEquals("HTTP/1.1 400 Bad Request", get(listener, "/callback?code=evil&state=guess"))
    assertEquals("HTTP/1.1 400 Bad Request", get(listener, "/callback?code=evil"))
    assertNull(listener.outcomeOrNull)
    assertEquals("HTTP/1.1 200 OK", get(listener, "/callback?state=expected&code=good"))
    assertEquals(LoopbackOutcome.Received("/callback?state=expected&code=good"), awaitOutcome(listener))
  }

  @Test
  fun refusesOtherPathsMethodsHostsAndUnarmedCallbacks() {
    val listener = listener()
    assertEquals("HTTP/1.1 503 Service Unavailable", get(listener, "/callback?state=x&code=c"))
    listener.arm("x")
    assertEquals("HTTP/1.1 404 Not Found", get(listener, "/favicon.ico"))
    assertEquals("HTTP/1.1 404 Not Found", get(listener, "/callback/extra?state=x"))
    assertEquals(
      "HTTP/1.1 405 Method Not Allowed",
      request(listener.port, "POST /callback?state=x HTTP/1.1\r\nHost: 127.0.0.1:${listener.port}\r\n\r\n"),
    )
    assertEquals("HTTP/1.1 400 Bad Request", get(listener, "/callback?state=x", host = "attacker.example.test"))
    assertEquals("HTTP/1.1 400 Bad Request", get(listener, "/callback?state=x", host = "localhost:${listener.port}"))
    assertNull(listener.outcomeOrNull)
  }

  @Test
  fun decodesTheStateLikeUrlSearchParamsAndUsesTheFirstValue() {
    val listener = listener()
    listener.arm("a b/c")
    assertEquals("HTTP/1.1 400 Bad Request", get(listener, "/callback?state=wrong&state=a+b%2Fc"))
    assertEquals("HTTP/1.1 200 OK", get(listener, "/callback?state=a+b%2Fc&state=wrong"))
    assertTrue(awaitOutcome(listener) is LoopbackOutcome.Received)
  }

  @Test
  fun reportsAProviderErrorAsReceivedForTheAppToHandle() {
    val listener = listener()
    listener.arm("s")
    assertEquals("HTTP/1.1 200 OK", get(listener, "/callback?error=access_denied&state=s"))
    assertEquals(LoopbackOutcome.Received("/callback?error=access_denied&state=s"), awaitOutcome(listener))
  }

  @Test
  fun survivesConnectionsThatCloseOrResetEarly() {
    val listener = listener()
    listener.arm("s")
    val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
    // Connects and closes without sending anything.
    Socket(loopback, listener.port).close()
    // Sends half a request, then resets the connection.
    Socket(loopback, listener.port).use { socket ->
      socket.setSoLinger(true, 0)
      socket.getOutputStream().write("GET /callback?state=s".toByteArray())
    }
    // Connects and sends a valid request but never reads the response.
    Socket(loopback, listener.port).use { socket ->
      socket.setSoLinger(true, 0)
      socket
        .getOutputStream()
        .write("GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1:${listener.port}\r\n\r\n".toByteArray())
    }
    Thread.sleep(200)
    assertNull(listener.outcomeOrNull)
    assertEquals("HTTP/1.1 200 OK", get(listener, "/callback?state=s&code=good"))
    assertEquals(LoopbackOutcome.Received("/callback?state=s&code=good"), awaitOutcome(listener))
  }

  @Test
  fun keepsTheCallbackWhenTheBrowserDropsTheResponse() {
    val listener = listener()
    listener.arm("s")
    Socket(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), listener.port).use { socket ->
      socket.setSoLinger(true, 0)
      socket
        .getOutputStream()
        .write("GET /callback?state=s&code=kept HTTP/1.1\r\nHost: 127.0.0.1:${listener.port}\r\n\r\n".toByteArray())
      socket.getOutputStream().flush()
    }
    assertEquals(LoopbackOutcome.Received("/callback?state=s&code=kept"), awaitOutcome(listener))
  }

  @Test
  fun timesOut() {
    val listener = listener(timeoutMillis = 300)
    val outcome = awaitOutcome(listener)
    assertEquals(LoopbackListener.TIMEOUT, (outcome as LoopbackOutcome.Failed).code)
  }

  @Test
  fun cancelEndsTheAttemptAndCloses() {
    val listener = listener()
    listener.cancel()
    assertEquals(LoopbackListener.CANCELLED, (awaitOutcome(listener) as LoopbackOutcome.Failed).code)
  }

  @Test
  fun bindsOnlyToTheIpv4Loopback() {
    val listener = listener()
    val field = LoopbackListener::class.java.getDeclaredField("server")
    field.isAccessible = true
    val server = field.get(listener) as java.net.ServerSocket
    assertEquals("127.0.0.1", server.inetAddress.hostAddress)
  }

  @Test
  fun parsesHeadsStrictly() {
    val head = HttpHead.read(ByteArrayInputStream("GET /callback?a=1 HTTP/1.1\r\nHOST: 127.0.0.1:1\r\n\r\n".toByteArray()))
    assertEquals(RequestHead("GET", "/callback?a=1", "127.0.0.1:1"), head?.let(HttpHead::parse))
    assertNull(HttpHead.read(ByteArrayInputStream("GET / HTTP/1.1\r\n".toByteArray())))
    assertNull(HttpHead.read(ByteArrayInputStream(ByteArray(HttpHead.MAX_HEAD_BYTES + 10) { 'a'.code.toByte() })))
    assertNull(HttpHead.parse("GARBAGE\r\n\r\n"))
    assertNull(HttpHead.queryParams("/callback?state=%ZZ"))
    assertEquals(mapOf("state" to "x"), HttpHead.queryParams("/callback?state=x#frag"))
  }

  @Test
  fun comparesSecretsExactly() {
    assertTrue(LoopbackListener.sameSecret("abc", "abc"))
    assertTrue(!LoopbackListener.sameSecret("abc", "abd"))
    assertTrue(!LoopbackListener.sameSecret("abc", "abcd"))
  }
}
