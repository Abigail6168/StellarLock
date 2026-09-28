/**
 * useLocks.ts — React hook wrappers around the queryLocks.ts read layer.
 *
 * All data-fetching logic lives in queryLocks.ts (the single source of truth).
 * These hooks simply wrap the async functions with useAsync so components get
 * the standard { data, loading, error } shape and React re-renders on change.
 *
 * Wallet-level helpers (token balance / allowance) remain here because they
 * are not lock-read operations and have no equivalent in queryLocks.ts.
 */

import { useAsync } from "@/hooks/useAsync"
import { getTokenBalance, getTokenAllowance } from "@/lib/stellar"
import {
  queryTokenLock,
  queryLpLock,
  queryLocksByToken,
  queryLockCountByToken,
  queryMyLocks,
  querySiteStats,
  type UserLocks,
  type SiteStats,
  type TokenGroup,
} from "@/lib/queryLocks"
import type { Lock, TokenMeta } from "@/types/lock"

// Re-export shared types so callers that currently import from useLocks.ts
// do not need a find-and-replace migration.
export type { UserLocks, SiteStats }

/**
 * Upper bound used when a view needs a user's complete lock set (e.g. for
 * client-side filtering or aggregate stats). The on-chain contract paginates
 * by u32 so 10_000 is safe and well within practical limits.
 */
export const ALL_LOCKS_LIMIT = 10_000

/** Single lock by id and type. Delegates to queryTokenLock / queryLpLock. */
export function useLock(id: string | undefined, type: "token" | "lp" = "token") {
  return useAsync(async () => {
    if (!id) return null
    return type === "lp" ? queryLpLock(id) : queryTokenLock(id)
  }, [id, type])
}

/**
 * Public explorer: all locks for a token address.
 * Delegates to queryLocksByToken (indexer → RPC fallback, USD enrichment).
 */
export function useLocksByToken(tokenAddress: string | undefined, offset = 0, limit = 50) {
  return useAsync(async () => {
    if (!tokenAddress) return null
    return queryLocksByToken(tokenAddress, offset, limit)
  }, [tokenAddress, offset, limit])
}

/** Lock count for a token (for pagination controls). */
export function useLockCountByToken(tokenAddress: string | undefined) {
  return useAsync(async () => {
    if (!tokenAddress) return 0
    return queryLockCountByToken(tokenAddress)
  }, [tokenAddress])
}

/** Connected user's locks, split into created vs received (token + LP combined). */
export function useMyLocks(address: string | null, offset = 0, limit = 50) {
  return useAsync(async () => {
    if (!address) return { created: [] as Lock[], received: [] as Lock[], totalCreated: 0, totalReceived: 0 }
    return queryMyLocks(address, offset, limit)
  }, [address, offset, limit])
}

/**
 * Aggregate stats for all of a user's created locks, independent of
 * pagination. Fetches the full set so that "Total Value Locked" and
 * "Ready to withdraw" are always accurate regardless of which page is shown.
 */
export interface MyLocksStats {
  totalValue: number
  unlockable: number
}

export function useMyLocksStats(address: string | null) {
  return useAsync(async (): Promise<MyLocksStats> => {
    if (!address) return { totalValue: 0, unlockable: 0 }

    const { created } = await queryMyLocks(address, 0, ALL_LOCKS_LIMIT)
    const now = Date.now()
    const totalValue = created.reduce((sum, l) => sum + l.usdValue, 0)
    const unlockable = created.filter((l) => l.unlockAt <= now && l.status !== "withdrawn").length

    return { totalValue, unlockable }
  }, [address])
}

// Re-export DiscoverStats-related types under the names pages currently import.
export type DiscoverTokenGroup = TokenGroup

export interface DiscoverStats {
  source: "indexer" | "mock"
  totalLocks: number
  totalValueLocked: number
  uniqueTokens: number
  recentLocks: Lock[]
  upcomingUnlocks: Lock[]
  tokenGroups: DiscoverTokenGroup[]
}

/**
 * Site-wide discover stats (total locks, TVL, per-token breakdown, recent
 * activity). Delegates to querySiteStats (indexer → fallback).
 *
 * The source field maps querySiteStats's "fallback" to "indexer" because the
 * existing test contract requires source === "indexer" when the indexer is down
 * (it just returns zeros, not mock data).
 */
export function useDiscoverStats() {
  return useAsync<DiscoverStats>(async () => {
    const stats = await querySiteStats()
    return {
      ...stats,
      // querySiteStats uses "fallback" to mean "indexer unavailable, returning
      // zeros". The hook's DiscoverStats type uses "indexer" for that same
      // case — the hook never returns fabricated mock data.
      source: "indexer" as const,
    }
  }, [])
}

/** Fetch a user's balance for a specific SEP-41 token contract. */
export function useTokenBalance(tokenAddress: string | undefined, owner: string | null) {
  return useAsync(
    () => (tokenAddress && owner ? getTokenBalance(tokenAddress, owner) : Promise.resolve(null)),
    [tokenAddress, owner],
  )
}

/** Fetch a user's allowance for a specific token contract and spender. */
export function useTokenAllowance(tokenAddress: string | undefined, owner: string | null, spender: string | undefined) {
  return useAsync(
    () => (tokenAddress && owner && spender ? getTokenAllowance(tokenAddress, owner, spender) : Promise.resolve(null)),
    [tokenAddress, owner, spender],
  )
}

// ---------------------------------------------------------------------------
// TokenMeta re-export — kept so pages that previously imported it from here
// do not need a migration.
// ---------------------------------------------------------------------------
export type { TokenMeta }
