/**
 * Unit tests for src/lib/prices.ts — #327
 *
 * Covers:
 *  - Cache TTL: prices are served from cache within 1 minute, re-fetched after expiry
 *  - In-flight deduplication: concurrent calls for the same token share one fetch
 *  - estimateUsdValue: multiplies price × amount, returns 0 for non-positive amounts
 *  - fetchPricesBatch: deduplicates addresses and returns a Map per address
 *  - invalidatePriceCache: clears all cached prices
 *  - Contract token (C... address) always returns 0 — known gap documented in issue
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { getTokenPriceUsd, estimateUsdValue, fetchPricesBatch, invalidatePriceCache, hasPriceFeed } from "@/lib/prices"

// ── helpers ────────────────────────────────────────────────────────────────────

/** Build a minimal Horizon order_book response with given bid/ask prices. */
function orderBookResponse(bid: string, ask: string) {
  return {
    ok: true,
    json: () => ({
      bids: [{ price: bid }],
      asks: [{ price: ask }],
    }),
  } as unknown as Response
}

function emptyOrderBook() {
  return {
    ok: true,
    json: () => ({ bids: [], asks: [] }),
  } as unknown as Response
}

function failedResponse(status = 500) {
  return { ok: false, status, json: () => ({}) } as unknown as Response
}

// A classic Stellar asset address (G...) — prices.ts only supports these via
// Horizon orderbook. Contract tokens (C...) always return 0.
const CONTRACT_TOKEN = "CBFCKEOQRQIXKLGU4QBUQVOINOKFBOXJ37LXEKLKNUO6TW4FNGDU26AW"

// ── tests ──────────────────────────────────────────────────────────────────────

describe("prices", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    invalidatePriceCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ── getTokenPriceUsd ─────────────────────────────────────────────────────

  describe("getTokenPriceUsd — native XLM", () => {
    it("returns the mid-market XLM/USD price from the Horizon orderbook", async () => {
      // bid = 0.10, ask = 0.12 → mid = 0.11
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(orderBookResponse("0.10", "0.12")))

      const price = await getTokenPriceUsd("native")

      expect(price).toBeCloseTo(0.11)
    })

    it("returns 0 when Horizon returns a non-OK response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failedResponse()))

      const price = await getTokenPriceUsd("native")

      expect(price).toBe(0)
    })

    it("returns 0 when the orderbook has no bids or asks", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(emptyOrderBook()))

      const price = await getTokenPriceUsd("native")

      expect(price).toBe(0)
    })

    it("returns 0 when fetch throws", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")))

      const price = await getTokenPriceUsd("native")

      expect(price).toBe(0)
    })
  })

  describe("getTokenPriceUsd — empty string treated as native XLM", () => {
    it("treats empty string as native XLM", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(orderBookResponse("0.08", "0.10")))

      const price = await getTokenPriceUsd("")

      expect(price).toBeCloseTo(0.09)
    })
  })

  describe("getTokenPriceUsd — contract tokens (C... address)", () => {
    it("always returns 0 for Soroban contract token addresses (known limitation)", async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)

      const price = await getTokenPriceUsd(CONTRACT_TOKEN)

      // Contract tokens can't be queried via Horizon orderbook — the implementation
      // short-circuits and returns 0 without making any fetch calls for the token.
      expect(price).toBe(0)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  // ── hasPriceFeed (Issue #741) ────────────────────────────────────────────

  describe("hasPriceFeed", () => {
    it("is true for native XLM", () => {
      expect(hasPriceFeed("native")).toBe(true)
    })

    it("is true for the empty-string native alias", () => {
      expect(hasPriceFeed("")).toBe(true)
    })

    it("is false for a Soroban contract token address", () => {
      expect(hasPriceFeed(CONTRACT_TOKEN)).toBe(false)
    })
  })

  // ── Cache TTL ────────────────────────────────────────────────────────────

  describe("cache TTL", () => {
    it("serves the cached XLM price within the 60-second TTL without a second fetch", async () => {
      const fetchMock = vi.fn().mockResolvedValue(orderBookResponse("0.10", "0.12"))
      vi.stubGlobal("fetch", fetchMock)

      await getTokenPriceUsd("native")
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // Advance by 59 seconds — still within TTL
      await vi.advanceTimersByTimeAsync(59_000)
      await getTokenPriceUsd("native")
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("re-fetches after the 60-second TTL expires", async () => {
      const fetchMock = vi.fn().mockResolvedValue(orderBookResponse("0.10", "0.12"))
      vi.stubGlobal("fetch", fetchMock)

      await getTokenPriceUsd("native")
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // Advance past TTL
      await vi.advanceTimersByTimeAsync(61_000)
      await getTokenPriceUsd("native")
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  // ── In-flight deduplication ──────────────────────────────────────────────

  describe("in-flight deduplication", () => {
    it("deduplicates concurrent calls for the same token into one fetch", async () => {
      // Use a deferred promise so both calls are in-flight simultaneously
      let resolveOrder!: (v: Response) => void
      const gate = new Promise<Response>((res) => {
        resolveOrder = res
      })
      const fetchMock = vi.fn().mockReturnValue(gate)
      vi.stubGlobal("fetch", fetchMock)

      const p1 = getTokenPriceUsd("native")
      const p2 = getTokenPriceUsd("native")

      resolveOrder(orderBookResponse("0.10", "0.12"))
      const [r1, r2] = await Promise.all([p1, p2])

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(r1).toBeCloseTo(0.11)
      expect(r2).toBeCloseTo(0.11)
    })
  })

  // ── invalidatePriceCache ─────────────────────────────────────────────────

  describe("invalidatePriceCache", () => {
    it("forces a fresh fetch on the next call after cache is invalidated", async () => {
      const fetchMock = vi.fn().mockResolvedValue(orderBookResponse("0.10", "0.12"))
      vi.stubGlobal("fetch", fetchMock)

      await getTokenPriceUsd("native")
      expect(fetchMock).toHaveBeenCalledTimes(1)

      invalidatePriceCache()

      await getTokenPriceUsd("native")
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  // ── estimateUsdValue ─────────────────────────────────────────────────────

  describe("estimateUsdValue", () => {
    it("multiplies price × amount to produce the USD value", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(orderBookResponse("0.10", "0.12")))

      const usd = await estimateUsdValue("native", 100)

      // mid = 0.11, 100 * 0.11 = 11
      expect(usd).toBeCloseTo(11)
    })

    it("returns 0 immediately when amount is 0 without fetching price", async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)

      const usd = await estimateUsdValue("native", 0)

      expect(usd).toBe(0)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("returns 0 when amount is negative", async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)

      const usd = await estimateUsdValue("native", -50)

      expect(usd).toBe(0)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("returns 0 when the token has no available price feed", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(emptyOrderBook()))

      const usd = await estimateUsdValue("native", 50)

      expect(usd).toBe(0)
    })
  })

  // ── fetchPricesBatch ─────────────────────────────────────────────────────

  describe("fetchPricesBatch", () => {
    it("returns a Map with an entry for each requested address", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(orderBookResponse("0.10", "0.12")))

      const map = await fetchPricesBatch(["native", CONTRACT_TOKEN])

      expect(map.has("native")).toBe(true)
      expect(map.has(CONTRACT_TOKEN)).toBe(true)
    })

    it("deduplicates repeated addresses and returns a single entry", async () => {
      const fetchMock = vi.fn().mockResolvedValue(orderBookResponse("0.10", "0.12"))
      vi.stubGlobal("fetch", fetchMock)

      const map = await fetchPricesBatch(["native", "native", "native"])

      expect(map.size).toBe(1)
      // Only one unique address, so Horizon is only hit once
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("stores 0 for addresses that fail to resolve", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failedResponse()))

      const map = await fetchPricesBatch(["native"])

      expect(map.get("native")).toBe(0)
    })

    it("returns an empty Map for an empty input array", async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)

      const map = await fetchPricesBatch([])

      expect(map.size).toBe(0)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
