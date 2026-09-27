import { NETWORK } from "@/lib/stellar"

// Native XLM asset identifier used by Horizon
const NATIVE = "native"
// USDC on Stellar testnet / mainnet
const USDC_ISSUER_TESTNET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const USDC_ISSUER_MAINNET = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

function usdcIssuer(): string {
  return NETWORK.id === "mainnet" ? USDC_ISSUER_MAINNET : USDC_ISSUER_TESTNET
}

interface CacheEntry {
  price: number
  expiry: number
}

// In-memory price cache: token address → { price, expiry }
const priceCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000 // 1 minute

// In-flight deduplication
const inflight = new Map<string, Promise<number>>()

/**
 * Fetch the mid-market price of `tokenAddress` in USD.
 * XLM (native) is priced via the Horizon USDC/XLM orderbook. Every other
 * token here is a Soroban contract address, for which no price feed is
 * implemented yet (see hasPriceFeed) — returns 0 in that case, not a real
 * price of zero.
 */
export async function getTokenPriceUsd(tokenAddress: string): Promise<number> {
  // XLM native
  if (tokenAddress === NATIVE || tokenAddress === "") return await xlmPriceUsd()

  const cached = priceCache.get(tokenAddress)
  if (cached && cached.expiry > Date.now()) return cached.price

  const existing = inflight.get(tokenAddress)
  if (existing) return existing

  const promise = fetchPrice(tokenAddress)
    .then((price) => {
      priceCache.set(tokenAddress, { price, expiry: Date.now() + CACHE_TTL_MS })
      inflight.delete(tokenAddress)
      return price
    })
    .catch(() => {
      inflight.delete(tokenAddress)
      return 0
    })

  inflight.set(tokenAddress, promise)
  return promise
}

function fetchPrice(tokenAddress: string): Promise<number> {
  // Issue #741: every locked token in this app is a Soroban contract
  // address (starts with "C"), and Horizon's orderbook can only price
  // classic Stellar assets (issuer accounts, "G..."), never a contract
  // address — there is no code path here that could ever price one. The
  // previous version routed through xlmPriceUsd()/tokenToXlmPrice() before
  // discovering that three calls deep, which both wasted a network round
  // trip and looked like a real (if unlucky) price lookup rather than a
  // known, guaranteed miss. Checking hasPriceFeed() first makes that
  // explicit and primary instead.
  //
  // No Soroban-native price source (DEX pool/AMM query) exists yet, so
  // this still returns 0 for every real token here; callers that need to
  // distinguish "genuinely zero" from "no price feed available" can check
  // hasPriceFeed() below instead of treating this 0 as a real price.
  if (!hasPriceFeed(tokenAddress)) return Promise.resolve(0)

  // Only a hypothetical classic (non-contract) Stellar asset reaches here;
  // no such token exists anywhere else in this codebase today.
  return Promise.resolve(0)
}

/**
 * Whether a real price feed can currently be sourced for `tokenAddress`.
 * Every token in this app is a Soroban contract address ("C..."), and
 * Horizon's orderbook — the only price source implemented so far — can
 * only price classic Stellar assets, never a contract address. Until a
 * Soroban-native price source (e.g. a DEX pool/AMM query) is implemented,
 * this is always false for a real token; use it to show "price
 * unavailable" instead of a misleading "$0.00".
 */
export function hasPriceFeed(tokenAddress: string): boolean {
  // Native XLM has a real feed (the Horizon USDC/XLM orderbook).
  if (tokenAddress === NATIVE || tokenAddress === "") return true
  // Every other token here is a Soroban contract address, which Horizon's
  // orderbook cannot price. No Soroban-native price source exists yet.
  return !tokenAddress.startsWith("C")
}

/** Fetch XLM/USD price via USDC/XLM orderbook on Horizon. */
async function xlmPriceUsd(): Promise<number> {
  const cached = priceCache.get(NATIVE)
  if (cached && cached.expiry > Date.now()) return cached.price

  const existing = inflight.get(NATIVE)
  if (existing) return existing

  // fetchXlmPrice already catches its own errors and resolves 0, so no
  // .catch() is needed here to clear the in-flight entry on failure.
  const promise = fetchXlmPrice().then((price) => {
    priceCache.set(NATIVE, { price, expiry: Date.now() + CACHE_TTL_MS })
    inflight.delete(NATIVE)
    return price
  })

  inflight.set(NATIVE, promise)
  return promise
}

async function fetchXlmPrice(): Promise<number> {
  try {
    const issuer = usdcIssuer()
    const url =
      `${NETWORK.horizonUrl}/order_book` +
      `?selling_asset_type=native` +
      `&buying_asset_type=credit_alphanum4` +
      `&buying_asset_code=USDC` +
      `&buying_asset_issuer=${issuer}` +
      `&limit=1`

    const res = await fetch(url)
    if (!res.ok) return 0

    const data = (await res.json()) as {
      bids: { price: string }[]
      asks: { price: string }[]
    }

    const bid = Number(data.bids?.[0]?.price ?? 0)
    const ask = Number(data.asks?.[0]?.price ?? 0)
    return bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask
  } catch {
    return 0
  }
}

/**
 * Estimate the USD value of `amount` units of `tokenAddress`.
 * Returns 0 if no price feed is available.
 */
export async function estimateUsdValue(tokenAddress: string, amount: number): Promise<number> {
  if (amount <= 0) return 0
  const price = await getTokenPriceUsd(tokenAddress)
  return price * amount
}

/** Batch-fetch USD prices for multiple token addresses. */
export async function fetchPricesBatch(tokenAddresses: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(tokenAddresses)]
  const results = await Promise.allSettled(unique.map((addr) => getTokenPriceUsd(addr)))
  const map = new Map<string, number>()
  unique.forEach((addr, i) => {
    const r = results[i]
    map.set(addr, r.status === "fulfilled" ? r.value : 0)
  })
  return map
}

/** Invalidate the full price cache (e.g. after a lock is created). */
export function invalidatePriceCache(): void {
  priceCache.clear()
}
