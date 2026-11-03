import { randomUUID } from 'expo-crypto'

/** Client id for a prompt submission (lets Cindl track its outcome; never retried automatically). */
export function newClientId(): string {
  return randomUUID()
}
