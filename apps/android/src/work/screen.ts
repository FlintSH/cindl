/**
 * Work, Computer on Android: the agent screen's state and who holds control,
 * never the live picture. ADR 0012's viewer (display.watch, frame, input) is
 * not in the Android app yet, so the card says so even when computer.view is
 * available (the labelled demo streams a synthetic screen) and the real
 * client passes no screen socket (computer.view then stays `limited`).
 */
export const NO_LIVE_PICTURE =
  'The live picture is not in the Android app yet: this card shows the screen state and who controls it. Cindl on the web or desktop shows the picture.'

/** Taking control from Android pauses Hermes's input; there is nothing to type into here. */
export const TAKE_CONTROL_WARNING =
  "Taking control pauses Hermes's input on its screen and evicts any other controller. This app cannot show the screen or send input yet, so give control back when you are done."
