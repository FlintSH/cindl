import { afterEach, describe, expect, it } from 'vitest'
import {
  connectRawClient,
  startFakeHermes,
  type FakeHermes,
} from '../src/fake-hermes/index.ts'

const fakes: FakeHermes[] = []
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close()
})

type Observed = { result: { viewer_id: string } }

describe('fake Hermes: display.lease.release (lease.py:204-226)', () => {
  it('releases with force only the lease the named viewer holds', async () => {
    const f = await startFakeHermes()
    fakes.push(f)
    const holder = await connectRawClient(f, f.signIn())
    const stranger = await connectRawClient(f, f.signIn())
    const held = ((await holder.request('display.observe', {})) as Observed).result
    await holder.request('display.lease.acquire', { viewer_id: held.viewer_id })
    const own = ((await stranger.request('display.observe', {})) as Observed).result
    // force skips the minted-id check, not the holder check.
    await stranger.request('display.lease.release', {
      viewer_id: own.viewer_id,
      force: true,
    })
    expect(f.store.display.holderViewerId).toBe(held.viewer_id)
    // The holder's id, from a connection that did not mint it, releases with force.
    await stranger.request('display.lease.release', {
      viewer_id: held.viewer_id,
      force: true,
    })
    expect(f.store.display.holder).toBe('agent')
    holder.close()
    stranger.close()
  })
})
