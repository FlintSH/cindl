package dev.fl1nt.cindl.loopback

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * One sign-in attempt at a time, kept for the life of the process so that a
 * reloaded JavaScript runtime can re-attach to an attempt that is still
 * listening. Process death ends the attempt; the app then reports it as
 * interrupted (see src/auth/signIn.ts).
 */
internal object LoopbackRegistry {
  private var attemptId: String? = null
  private var listener: LoopbackListener? = null

  @Synchronized
  fun start(id: String, timeoutMillis: Long): LoopbackListener {
    listener?.cancel()
    val next = LoopbackListener(timeoutMillis).start()
    attemptId = id
    listener = next
    return next
  }

  @Synchronized
  fun find(id: String): LoopbackListener? = if (id == attemptId) listener else null

  @Synchronized
  fun cancel(id: String) {
    if (id != attemptId) return
    listener?.cancel()
  }
}

class CindlLoopbackModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CindlLoopback")

    AsyncFunction("start") { attemptId: String, timeoutMillis: Int ->
      require(attemptId.isNotEmpty()) { "attemptId must not be empty" }
      require(timeoutMillis in 1..MAX_TIMEOUT_MILLIS) { "timeout out of range" }
      mapOf("port" to LoopbackRegistry.start(attemptId, timeoutMillis.toLong()).port)
    }

    Function("arm") { attemptId: String, expectedState: String ->
      val listener = LoopbackRegistry.find(attemptId)
      if (listener != null) listener.arm(expectedState)
      listener != null
    }

    AsyncFunction("awaitCallback") { attemptId: String, promise: Promise ->
      val listener = LoopbackRegistry.find(attemptId)
      if (listener == null) {
        promise.reject("ERR_LOOPBACK_UNKNOWN_ATTEMPT", "No sign-in is waiting in this process.", null)
      } else {
        listener.onOutcome { outcome ->
          when (outcome) {
            is LoopbackOutcome.Received -> promise.resolve(outcome.target)
            is LoopbackOutcome.Failed -> promise.reject(outcome.code, outcome.message, null)
          }
        }
      }
    }

    /** "listening", "received", "ended" or "unknown" (not in this process). */
    Function("status") { attemptId: String ->
      when (LoopbackRegistry.find(attemptId)?.outcomeOrNull) {
        null -> if (LoopbackRegistry.find(attemptId) == null) "unknown" else "listening"
        is LoopbackOutcome.Received -> "received"
        is LoopbackOutcome.Failed -> "ended"
      }
    }

    Function("cancel") { attemptId: String -> LoopbackRegistry.cancel(attemptId) }
  }

  private companion object {
    const val MAX_TIMEOUT_MILLIS = 15 * 60 * 1000
  }
}
