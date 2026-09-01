import { describe, expect, it } from 'vitest'
import { privateSessionKey } from './PrivateSession'

/**
 * The lock as an execution boundary rather than a rendering one (H2/H3 of the source review).
 *
 * These are four states the panel actually passes through, not four permutations of two booleans:
 * a cold boot before the session answers, a locked panel, an unlocked one, and the moment a
 * different member unlocks. The key is what React mounts the private subtree by, so "returns null"
 * means every provider under it is unmounted — no polling, no cache, nothing to leak — and "returns
 * a different number" means the subtree is discarded and rebuilt rather than handed on.
 */
describe('privateSessionKey', () => {
  it('refuses to run while locked, however confirmed the profile is', () => {
    // The whole finding in one assertion: being drawn or not drawn was never the question.
    expect(privateSessionKey(true, 1)).toBeNull()
  })

  it('refuses to run before anybody is selected', () => {
    // The cold-boot frame, before the session call answers. An unlocked panel with no identity has
    // nothing it could legitimately fetch.
    expect(privateSessionKey(false, null)).toBeNull()
    expect(privateSessionKey(true, null)).toBeNull()
  })

  it('runs as the unlocked profile', () => {
    expect(privateSessionKey(false, 1)).toBe(1)
  })

  it('changes key when the member changes, so the subtree is rebuilt not reused', () => {
    // Not `toBeTruthy` on both: the point is that the values *differ*, which is what makes React
    // discard the first member's providers instead of handing their contents to the second.
    expect(privateSessionKey(false, 1)).not.toBe(privateSessionKey(false, 2))
  })

  it('goes null between two members rather than straight across', () => {
    // A switch passes through the lock screen, so there is no frame in which the tree is mounted for
    // one member while the session already says another. That gap is what the abort-and-remount
    // ordering relies on.
    expect(privateSessionKey(true, 2)).toBeNull()
  })
})
