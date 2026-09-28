/**
 * Unit tests for src/hooks/useTokenBalanceSWR.ts — #469
 *
 * Covers:
 *  - Returns null / not loading when tokenAddress or owner is missing
 *  - Loads fresh (cache miss): starts loading, then resolves the balance
 *  - Serves a cached value immediately when the entry is still fresh (within ttlMs)
 *  - Stale-while-revalidate: serves the cached value immediately, then
 *    revalidates and updates it when the entry is older than ttlMs
 *  - `enabled: false` skips fetching entirely
 *  - `clear()` drops the cached entry and flips back to loading
 *  - `refetch()` forces a revalidation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"

vi.mock("@/lib/stellar", () => ({
  getTokenBalance: vi.fn(),
}))

vi.mock("@/lib/token-metadata", () => ({
  getOnChainTokenMeta: vi.fn(),
}))

import { getTokenBalance } from "@/lib/stellar"
import { getOnChainTokenMeta } from "@/lib/token-metadata"
import { useTokenBalanceSWR, clearTokenBalanceCache, clearTokenBalanceCacheForOwner } from "@/hooks/useTokenBalanceSWR"

const TOKEN = "CBFCKEOQRQIXKLGU4QBUQVOINOKFBOXJ37LXEKLKNUO6TW4FNGDU26AW"
const OWNER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"

const mockGetTokenBalance = vi.mocked(getTokenBalance)
const mockGetOnChainTokenMeta = vi.mocked(getOnChainTokenMeta)

describe("useTokenBalanceSWR", () => {
  beforeEach(() => {
    clearTokenBalanceCache()
    mockGetTokenBalance.mockReset()
    mockGetOnChainTokenMeta.mockReset()
    // Most existing tests below assume a standard 7-decimal token (matching
    // the old hardcoded 1e7 behavior); #747's dedicated test overrides this.
    mockGetOnChainTokenMeta.mockResolvedValue({ symbol: "TEST", name: "Test Token", decimals: 7 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearTokenBalanceCache()
  })

  it("returns null and is not loading when tokenAddress is missing", () => {
    const { result } = renderHook(() => useTokenBalanceSWR(undefined, OWNER))

    expect(result.current.balance).toBeNull()
    expect(result.current.isLoading).toBe(false)
    expect(mockGetTokenBalance).not.toHaveBeenCalled()
  })

  it("returns null and is not loading when owner is missing", () => {
    const { result } = renderHook(() => useTokenBalanceSWR(TOKEN, null))

    expect(result.current.balance).toBeNull()
    expect(result.current.isLoading).toBe(false)
    expect(mockGetTokenBalance).not.toHaveBeenCalled()
  })

  it("fetches and populates the balance on a cache miss", async () => {
    mockGetTokenBalance.mockResolvedValue(12.5)

    const { result } = renderHook(() => useTokenBalanceSWR(TOKEN, OWNER))

    expect(result.current.isLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    // 12.5 tokens -> 125_000_000 stroops (1e7 factor)
    expect(result.current.balance).toBe(125_000_000n)
    expect(mockGetTokenBalance).toHaveBeenCalledWith(TOKEN, OWNER)
  })

  it("encodes the cached balance using the token's real decimals, not a hardcoded 1e7 (#747)", async () => {
    // An 18-decimal token (e.g. a bridged/wrapped SEP-41 asset): the old
    // hardcoded-1e7 encoding would silently round this to 7 decimal places.
    mockGetOnChainTokenMeta.mockResolvedValue({ symbol: "W18", name: "Wide Token", decimals: 18 })
    mockGetTokenBalance.mockResolvedValue(2.5)

    const { result } = renderHook(() => useTokenBalanceSWR(TOKEN, OWNER))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Correct at 18 decimals: 2_500_000_000_000_000_000n.
    // The old hardcoded-1e7 bug would have produced 25_000_000n instead.
    expect(result.current.balance).toBe(2_500_000_000_000_000_000n)
  })

  it("serves a fresh cached value immediately without revalidating", async () => {
    mockGetTokenBalance.mockResolvedValue(10)

    const { result, unmount } = renderHook(() => useTokenBalanceSWR(TOKEN, OWNER, { ttlMs: 60_000 }))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(mockGetTokenBalance).toHaveBeenCalledTimes(1)
    unmount()

    // Remount with the same key — entry is fresh (well within ttlMs)
    const { result: result2 } = renderHook(() => useTokenBalanceSWR(TOKEN, OWNER, { ttlMs: 60_000 }))

    expect(result2.current.balance).toBe(100_000_000n)
    expect(result2.current.isLoading).toBe(false)
    expect(result2.current.isRevalidating).toBe(false)
    expect(mockGetTokenBalance).toHaveBeenCalledTimes(1)
  })

  it("serves the stale cached value immediately, then revalidates in the background", async () => {
    mockGetTokenBalance.mockResolvedValue(5)

    const { result, unmount } = renderHook(() => useTokenBalanceSWR(TOKEN, OWNER, { ttlMs: 10 }))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    unmount()

    // Let the cached entry go stale
    await new Promise((r) => setTimeout(r, 20))

    mockGetTokenBalance.mockResolvedValue(9)
    const { result: result2 } = renderHook(() => useTokenBalanceSWR(TOKEN, OWNER, { ttlMs: 10 }))

    // Stale value is shown immediately, not a loading state
    expect(result2.current.balance).toBe(50_000_000n)
    expect(result2.current.isLoading).toBe(false)

    await waitFor(() => {
      expect(result2.current.balance).toBe(90_000_000n)
    })
    expect(mockGetTokenBalance).toHaveBeenCalledTimes(2)
  })

  it("does not fetch when enabled is false", () => {
    const { result } = renderHook(() => useTokenBalanceSWR(TOKEN, OWNER, { enabled: false }))

    expect(result.current.isLoading).toBe(false)
    expect(mockGetTokenBalance).not.toHaveBeenCalled()
  })

  it("clear() removes the cached entry and flips back to loading", async () => {
    mockGetTokenBalance.mockResolvedValue(3)

    const { result } = renderHook(() => useTokenBalanceSWR(TOKEN, OWNER))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      result.current.clear()
    })

    expect(result.current.isLoading).toBe(true)
  })

  it("refetch() forces a fresh call to getTokenBalance", async () => {
    mockGetTokenBalance.mockResolvedValue(1)

    const { result } = renderHook(() => useTokenBalanceSWR(TOKEN, OWNER))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(mockGetTokenBalance).toHaveBeenCalledTimes(1)

    mockGetTokenBalance.mockResolvedValue(2)
    await act(async () => {
      await result.current.refetch()
    })

    expect(mockGetTokenBalance).toHaveBeenCalledTimes(2)
    expect(result.current.balance).toBe(20_000_000n)
  })

  it("clearTokenBalanceCacheForOwner only clears entries for that owner", async () => {
    mockGetTokenBalance.mockResolvedValue(1)
    const otherOwner = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF"

    const { unmount: unmount1 } = renderHook(() => useTokenBalanceSWR(TOKEN, OWNER))
    await waitFor(() => expect(mockGetTokenBalance).toHaveBeenCalledTimes(1))
    unmount1()

    const { unmount: unmount2 } = renderHook(() => useTokenBalanceSWR(TOKEN, otherOwner))
    await waitFor(() => expect(mockGetTokenBalance).toHaveBeenCalledTimes(2))
    unmount2()

    clearTokenBalanceCacheForOwner(OWNER)

    // OWNER's entry was cleared -> re-fetches; otherOwner's entry is still cached.
    const { result: r1 } = renderHook(() => useTokenBalanceSWR(TOKEN, OWNER))
    expect(r1.current.isLoading).toBe(true)

    const { result: r2 } = renderHook(() => useTokenBalanceSWR(TOKEN, otherOwner))
    expect(r2.current.isLoading).toBe(false)
  })
})
