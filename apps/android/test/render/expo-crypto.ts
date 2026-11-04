import { randomUUID as nodeRandomUUID } from 'node:crypto'

/**
 * expo-crypto in jsdom, as far as a rendered screen needs: the composer's
 * client ids (src/platform/ids.ts), from Node's crypto.
 */
export const randomUUID = () => nodeRandomUUID()
