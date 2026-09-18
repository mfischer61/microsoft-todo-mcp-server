import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TokenManager } from "./token-manager.js"
import type { StoredTokenData, TokenStore } from "./token-store.js"

// An in-memory stand-in for FileTokenStore -- these tests are about the
// refresh race, not disk I/O (that's covered in token-store.test.ts), so a
// fake keeps them fast and lets assertions read the store's contents
// directly.
class FakeTokenStore implements TokenStore {
  public data: StoredTokenData | null = null
  read(): StoredTokenData | null {
    return this.data
  }
  write(tokens: StoredTokenData): void {
    this.data = tokens
  }
}

function expiredTokens(overrides: Partial<StoredTokenData> = {}): StoredTokenData {
  return {
    accessToken: "stale-access-token",
    refreshToken: "refresh-token-v1",
    expiresAt: Date.now() - 1000, // already expired
    clientId: "client-id",
    clientSecret: "client-secret",
    tenantId: "organizations",
    ...overrides,
  }
}

describe("TokenManager refresh race", () => {
  let store: FakeTokenStore
  let manager: TokenManager
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    store = new FakeTokenStore()
    manager = new TokenManager(store)
    // doRefreshToken() falls back to these when a client id/secret aren't
    // already cached on currentTokens -- which is the case in the two tests
    // below that call refreshToken() directly instead of going through
    // getTokens() first.
    vi.stubEnv("CLIENT_ID", "client-id")
    vi.stubEnv("CLIENT_SECRET", "client-secret")

    // Simulates Microsoft's v2 token endpoint: every successful call rotates
    // the refresh token. A second call presenting the now-superseded refresh
    // token would be the exact race this test exists to rule out.
    let callCount = 0
    fetchMock = vi.fn(async () => {
      callCount += 1
      return {
        ok: true,
        json: async () => ({
          access_token: `fresh-access-token-${callCount}`,
          refresh_token: `refresh-token-v${callCount + 1}`,
          expires_in: 3600,
        }),
      } as Response
    })
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("only calls the token endpoint once when two callers refresh concurrently", async () => {
    store.data = expiredTokens()

    // Two "requests" (in the real server, two concurrent HTTP requests
    // hitting a 401 at the same time) both discover the token is expired and
    // both call refreshToken with the same refresh token, at the same time.
    const [resultA, resultB] = await Promise.all([
      manager.refreshToken("refresh-token-v1"),
      manager.refreshToken("refresh-token-v1"),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Both callers must get back the SAME refreshed token, not two different
    // ones from two different network calls.
    expect(resultA).toEqual(resultB)
    expect(store.data?.accessToken).toBe("fresh-access-token-1")
  })

  it("allows a later, separate refresh after the first one has finished", async () => {
    store.data = expiredTokens()

    await manager.refreshToken("refresh-token-v1")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A genuinely new refresh (e.g. the next time the token expires) is not
    // blocked by the mutex once the first one has resolved.
    await manager.refreshToken("refresh-token-v2")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("getTokens() triggers only one refresh even when called concurrently by two in-flight requests", async () => {
    store.data = expiredTokens()

    const [tokensA, tokensB] = await Promise.all([manager.getTokens(), manager.getTokens()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(tokensA?.accessToken).toBe(tokensB?.accessToken)
  })

  it("does not refresh at all when the cached token is still valid", async () => {
    store.data = expiredTokens({ expiresAt: Date.now() + 3600_000 })

    const tokens = await manager.getTokens()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(tokens?.accessToken).toBe("stale-access-token")
  })
})
