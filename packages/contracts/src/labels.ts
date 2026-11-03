/**
 * Labels every client must show while it displays synthetic data. They are
 * UI copy, not fixture data: every renderer build keeps them, so a demo
 * flavour that reuses a production renderer (desktop) can never show an
 * unlabelled synthetic scene. See ADR 0011.
 */
export const SYNTHETIC_DEMO_LABEL = 'Synthetic demo'

export const SYNTHETIC_DEMO_NOTICE =
  'Synthetic demo. Not connected to Hermes; every name, message and status here is invented.'

/** Product name suffix for packaged demo flavours (desktop, Android). */
export const DEMO_PRODUCT_NAME = 'Cindl Demo'
