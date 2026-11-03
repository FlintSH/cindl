/**
 * Entry point of Cindl Demo, a separate package (ADR 0011): the same
 * production renderer, with the SYNTHETIC scenario in main. The scenario never
 * contacts Hermes and reports `link.demo = true`, so the renderer shows its
 * notice; the window title and the product name carry the label as well.
 * This is the only main-process file that may import @cindl/fixtures.
 */
import { DEMO_PRODUCT_NAME, SYNTHETIC_DEMO_LABEL } from '@cindl/contracts'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { runCindl } from './app.ts'

export const DEMO_WINDOW_TITLE = `${DEMO_PRODUCT_NAME} (${SYNTHETIC_DEMO_LABEL.toLowerCase()})`

runCindl({
  kind: 'demo',
  windowTitle: DEMO_WINDOW_TITLE,
  createClient: ({ log }) => {
    log.warn(`${DEMO_PRODUCT_NAME}: synthetic scenario only; nothing reaches Hermes.`)
    return Promise.resolve({ client: createScenarioClient() })
  },
})
