import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getTokenBalance as getTokenBalanceNumber } from "../lib/stellar"
import { getOnChainTokenMeta } from "../lib/token-metadata"

interface BalanceCacheEntry {
  balance: bigint
  fetchedAt: number
}

type CacheKey = string

// In-memory cache shared across hook instances.
const cache = new Map<CacheKey, BalanceCacheEntry>()

const DEFAULT_TTL_MS = 30_000

function keyFor(tokenAddress: string, owner: string) {
  return `${tokenAddress}:${owner}`
}

export interface UseTokenBalanceSWROptions {
  ttlMs?: number
  enabled?: boolean
}

export function useTokenBalanceSWR(
  tokenAddress: string | undefined,
  owner: string | null,
  options: UseTokenBalanceSWROptions = {},
) {
  const { ttlMs = DEFAULT_TTL_MS, enabled = true } = options

  const token = tokenAddress?.trim()
  const addr = owner
  const cacheKey = token && addr ? keyFor(token, addr) : null

  const [balance, setBalance] = useState<bigint | null>(() => {
    if (!cacheKey) return null
    return cache.get(cacheKey)?.balance ?? null
  })

  const [isLoading, setIsLoading] = useState(() => {
    if (!cacheKey || !enabled) return false
    return !cache.has(cacheKey)
  })

  const [isRevalidating, setIsRevalidating] = useState(false)

  const latestCacheKeyRef = useRef(cacheKey)
  latestCacheKeyRef.current = cacheKey

  const revalidate = useCallback(async () => {
    if (!token || !addr) return
    if (!cacheKey) return

    setIsRevalidating(true)
    try {
      // getTokenBalance returns a float in whole tokens; convert back to the
      // token's smallest unit as a bigint for cache stability. Using a fixed
      // 1e7 here assumed every token has 7 decimals like XLM — wrong for any
      // SEP-41 token with a different `decimals()` value (Issue #747).
      const [fresh, { decimals }] = await Promise.all([getTokenBalanceNumber(token, addr), getOnChainTokenMeta(token)])
      const freshStroops = BigInt(Math.round(fresh * 10 ** decimals))

      cache.set(cacheKey, { balance: freshStroops, fetchedAt: Date.now() })

      if (latestCacheKeyRef.current === cacheKey) {
        setBalance(freshStroops)
      }
    } finally {
      setIsRevalidating(false)
      setIsLoading(false)
    }
  }, [token, addr, cacheKey])

  // Stale-while-revalidate behavior
  useEffect(() => {
    if (!enabled) return
    if (!cacheKey) {
      setBalance(null)
      setIsLoading(false)
      setIsRevalidating(false)
      return
    }

    const entry = cache.get(cacheKey)
    if (entry) {
      setBalance(entry.balance)

      const isStale = Date.now() - entry.fetchedAt > ttlMs
      if (isStale) {
        setIsLoading(false)
        void revalidate()
      } else {
        setIsLoading(false)
        setIsRevalidating(false)
      }
      return
    }

    setIsLoading(true)
    void revalidate()
  }, [cacheKey, enabled, ttlMs, revalidate])

  const clear = useCallback(() => {
    if (!cacheKey) return
    cache.delete(cacheKey)
    setIsLoading(true)
  }, [cacheKey])

  const refetch = useCallback(async () => {
    if (!cacheKey) return
    await revalidate()
  }, [cacheKey, revalidate])

  const state = useMemo(() => {
    return {
      balance,
      isLoading,
      isRevalidating,
      refetch,
      clear,
    }
  }, [balance, isLoading, isRevalidating, refetch, clear])

  return state
}

export function clearTokenBalanceCacheForOwner(owner: string) {
  for (const k of Array.from(cache.keys())) {
    if (k.endsWith(`:${owner}`)) cache.delete(k)
  }
}

export function clearTokenBalanceCache() {
  cache.clear()
}
