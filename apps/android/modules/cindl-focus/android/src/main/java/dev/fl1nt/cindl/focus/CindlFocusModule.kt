package dev.fl1nt.cindl.focus

import android.view.View
import android.view.ViewGroup
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Hardware keyboard focus for dialogs and sheets (src/overlay/keyboardFocus.ts).
 * React Native moves TalkBack focus, but a keyboard's focus only behind its
 * experimental imperative-focus flag; these two calls do that, and only that.
 */
class CindlFocusModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CindlFocus")

    /**
     * Keeps keyboard focus out of everything in `view` while `blocked` (an
     * open overlay covers it): Tab, Shift+Tab and the arrow keys then reach
     * only the overlay. A view in it that has focus already (a text field,
     * selectable text) gives it up, or keys would still reach it there.
     * Unblocked, or once it leaves the window (React Native may reuse the
     * view), it is a view group as Android makes one.
     */
    AsyncFunction("block") { view: View, blocked: Boolean ->
      val group = view as? ViewGroup ?: return@AsyncFunction false
      group.removeOnAttachStateChangeListener(UnblockOnDetach)
      if (blocked) {
        group.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        group.addOnAttachStateChangeListener(UnblockOnDetach)
        // Blocked first: out of touch mode, Android then looks for a new focus,
        // which it must not find in here.
        group.findFocus()?.clearFocus()
      } else {
        group.descendantFocusability = ViewGroup.FOCUS_BEFORE_DESCENDANTS
      }
      true
    }.runOnQueue(Queues.MAIN)

    /**
     * Gives keyboard focus to `view` or, when it cannot take it (a heading),
     * to the first control of its nearest ancestor that has one. Never in
     * touch mode: focus there follows the finger, and a text field given it
     * would open the on-screen keyboard.
     */
    AsyncFunction("focus") { view: View ->
      if (view.isInTouchMode) return@AsyncFunction false
      var target: View? = view
      while (target != null) {
        if (target.requestFocus()) return@AsyncFunction true
        target = target.parent as? View
      }
      false
    }.runOnQueue(Queues.MAIN)
  }
}

/** A view group blocked by `block` is unblocked as it leaves the window, so none is reused blocked. */
private object UnblockOnDetach : View.OnAttachStateChangeListener {
  override fun onViewAttachedToWindow(v: View) = Unit

  override fun onViewDetachedFromWindow(v: View) {
    (v as? ViewGroup)?.descendantFocusability = ViewGroup.FOCUS_BEFORE_DESCENDANTS
    v.removeOnAttachStateChangeListener(this)
  }
}
