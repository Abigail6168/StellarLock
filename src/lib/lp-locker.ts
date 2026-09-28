import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import type { Dex, Lock, LockMetadata } from "@/types/lock"
import { CONTRACTS, simulateCall, submitCall, submitCallWithHash, type TxPhase } from "@/lib/stellar"
import { getOnChainTokenMeta } from "@/lib/token-metadata"

export interface CreateLpLockArgs {
  poolShareAddress: string
  dex: Dex
  tokenA: string
  tokenB: string
  amount: number
  beneficiary: string
  unlockAt: number // unix seconds
  metadata?: { description?: string; projectUrl?: string; logoUrl?: string }
}

/**
 * Approve the LP-locker contract to pull `amount` of `tokenAddress` (typically an
 * LP/pool-share token) from `owner`'s balance, via the token's standard SEP-41
 * `approve` entrypoint. Must be called (and confirmed) before {@link createLpLock},
 * since `create_lock` performs a `transfer` that requires sufficient allowance.
 *
 * Note: this targets `tokenAddress` directly (not the lp-locker contract), so any
 * errors surfaced come from that token contract's own implementation, not the
 * lp-locker's `ContractError` enum.
 *
 * @param tokenAddress - Contract address of the pool-share/LP token to approve.
 * @param owner - Address granting the allowance (the wallet that will create the lock).
 * @param spender - Address allowed to spend the allowance — normally the lp-locker contract id.
 * @param amount - Human-readable amount to approve (converted to the token's smallest unit using its real on-chain decimals).
 * @param sourceAddress - Address submitting the transaction; must equal `owner` for `require_auth` to pass.
 * @param signTransaction - Callback that signs the built transaction XDR and returns signed XDR.
 * @returns Resolves with no value once the approval transaction is confirmed.
 * @throws {Error} `Simulation error: ...` / `Send error: ...` / `Transaction failed: ...` if
 *   `sourceAddress` fails auth as `owner`, or for RPC/network failures. The expiration ledger is
 *   hard-coded to `0`, so a `0` allowance is effectively immediately expired if not spent promptly.
 */
export async function submitTokenApproval(
  tokenAddress: string,
  owner: string,
  spender: string,
  amount: number,
  sourceAddress: string,
  signTransaction: (xdr: string) => Promise<{ signedTxXdr: string }>,
): Promise<void> {
  // Issue #740: was hardcoded to 7 decimals regardless of the LP/pool-share
  // token's real decimals(), breaking the approve-then-lock flow for any
  // token that isn't 7 decimals. This is a duplicate of stellar.ts's
  // submitTokenApproval, kept separate here because the two are exercised
  // by test suites that mock @/lib/stellar and @/lib/lp-locker independently
  // of each other; both copies now fetch and use the real decimals.
  const { decimals } = await getOnChainTokenMeta(tokenAddress)
  const amountStroops = BigInt(Math.round(amount * 10 ** decimals))
  const expirationLedger = 0

  const scArgs: xdr.ScVal[] = [
    new Address(owner).toScVal(),
    new Address(spender).toScVal(),
    nativeToScVal(amountStroops, { type: "i128" }),
    nativeToScVal(expirationLedger, { type: "u32" }),
  ]

  await submitCall(tokenAddress, "approve", scArgs, sourceAddress, signTransaction)
}

/** LockMetadata is stored non-optionally on-chain; empty strings mean "not set". */
function parseMetadata(raw: unknown): LockMetadata | undefined {
  const m = raw as { description: string; project_url: string; logo_url: string } | null | undefined
  if (!m || (!m.description && !m.project_url && !m.logo_url)) return undefined
  return { description: m.description, projectUrl: m.project_url, logoUrl: m.logo_url }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function idArg(id: string): xdr.ScVal {
  return nativeToScVal(BigInt(id), { type: "u64" })
}

function addressArg(addr: string): xdr.ScVal {
  return new Address(addr).toScVal()
}

/** LockMetadata is a plain (non-Option) struct on-chain — always send a full map. */
function metadataArg(metadata: CreateLpLockArgs["metadata"]): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("description"),
      val: nativeToScVal(metadata?.description ?? "", { type: "string" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("logo_url"),
      val: nativeToScVal(metadata?.logoUrl ?? "", { type: "string" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("project_url"),
      val: nativeToScVal(metadata?.projectUrl ?? "", { type: "string" }),
    }),
  ])
}

/**
 * Encode the Dex enum as a Soroban contracttype enum ScVal.
 * On-chain: enum Dex { Aquarius = 0, Soroswap = 1 }
 * Soroban encodes enum variants as a single-element vec: [Symbol("VariantName")]
 */
function dexArg(dex: Dex): xdr.ScVal {
  const variant = dex === "aquarius" ? "Aquarius" : "Soroswap"
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)])
}

// ── Converters ────────────────────────────────────────────────────────────────

interface LpMeta {
  tokenASymbol: string
  tokenBSymbol: string
  poolDecimals: number
}

function toLpLock(raw: Record<string, unknown>, meta?: LpMeta): Lock {
  const poolShare = raw.pool_share as string
  const dexRaw = raw.dex as { tag?: string } | string
  const dex: Dex = (
    typeof dexRaw === "object" && dexRaw?.tag
      ? dexRaw.tag.toLowerCase()
      : typeof dexRaw === "string"
        ? dexRaw.toLowerCase()
        : ""
  ) as Dex
  const tokenA = raw.token_a as string
  const tokenB = raw.token_b as string

  const tokenASymbol = meta?.tokenASymbol ?? tokenA.slice(0, 4)
  const tokenBSymbol = meta?.tokenBSymbol ?? tokenB.slice(0, 4)
  const poolDecimals = meta?.poolDecimals ?? 7
  const multiplier = 10 ** poolDecimals

  return {
    id: String(raw.id),
    kind: "lp",
    status: raw.withdrawn ? "withdrawn" : Number(raw.unlock_at) * 1000 <= Date.now() ? "unlockable" : "locked",
    token: {
      address: poolShare,
      symbol: `${tokenASymbol}-${tokenBSymbol} LP`,
      name: `${tokenASymbol}/${tokenBSymbol} Pool Share`,
      decimals: poolDecimals,
    },
    dex,
    poolPair: [tokenA, tokenB],
    creator: raw.creator as string,
    beneficiary: raw.beneficiary as string,
    amount: Number(raw.amount) / multiplier,
    usdValue: 0,
    createdAt: Number(raw.created_at) * 1000,
    unlockAt: Number(raw.unlock_at) * 1000,
    extendedCount: Number(raw.extended_count),
    metadata: parseMetadata(raw.metadata),
  }
}

/** Fetch on-chain metadata for LP locks: tokenA/tokenB symbols + pool share decimals. */
async function enrichLpLocks(raws: Record<string, unknown>[]): Promise<Lock[]> {
  const tokenAAddrs = [...new Set(raws.map((r) => r.token_a as string))]
  const tokenBAddrs = [...new Set(raws.map((r) => r.token_b as string))]
  const poolAddrs = [...new Set(raws.map((r) => r.pool_share as string))]

  const allAddrs = [...new Set([...tokenAAddrs, ...tokenBAddrs, ...poolAddrs])]
  const entries = await Promise.all(allAddrs.map(async (addr) => [addr, await getOnChainTokenMeta(addr)] as const))
  const metaMap = new Map(entries)

  return raws.map((r) => {
    const tokenAMeta = metaMap.get(r.token_a as string)
    const tokenBMeta = metaMap.get(r.token_b as string)
    const poolMeta = metaMap.get(r.pool_share as string)
    return toLpLock(r, {
      tokenASymbol: tokenAMeta?.symbol ?? (r.token_a as string).slice(0, 4),
      tokenBSymbol: tokenBMeta?.symbol ?? (r.token_b as string).slice(0, 4),
      poolDecimals: poolMeta?.decimals ?? 7,
    })
  })
}

// ── Read methods ──────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 50

function paginationArgs(offset: number, limit: number): xdr.ScVal[] {
  return [nativeToScVal(offset, { type: "u32" }), nativeToScVal(limit, { type: "u32" })]
}

/**
 * Fetch a single LP lock by id via a read-only contract simulation (`get_lock`),
 * enriched with on-chain token metadata for the underlying pool pair (symbols/decimals).
 *
 * @param id - Numeric lock id (as a decimal string), assigned by the contract at creation time.
 * @returns The parsed {@link Lock} (`kind: "lp"`), or `null` if no lock with that id exists on-chain.
 * @throws {Error} `Simulation error: ...` if the RPC simulation itself fails. Does not throw a
 *   {@link ContractError} — a missing lock simply resolves to `null` since `get_lock` returns
 *   `Option<LpLock>` on-chain.
 */
export async function getLpLock(id: string): Promise<Lock | null> {
  const raw = await simulateCall<Record<string, unknown> | null>(CONTRACTS.lpLocker, "get_lock", [idArg(id)])
  return raw ? toLpLock(raw) : null
}

/**
 * List LP locks created by a given address, paginated server-side by the
 * contract's `ByCreator` index.
 *
 * @param address - Stellar `G...`/`C...` address of the lock creator.
 * @param offset - Zero-based index into the creator's lock list to start from (default `0`).
 * @param limit - Maximum number of locks to return in this page (default {@link DEFAULT_PAGE_SIZE}).
 * @returns Enriched {@link Lock} objects (empty array if the creator has no LP locks).
 * @throws {Error} `Simulation error: ...` if the read-only simulation fails.
 */
export async function getLpLocksByCreator(address: string, offset = 0, limit = DEFAULT_PAGE_SIZE): Promise<Lock[]> {
  const raw = await simulateCall<Record<string, unknown>[]>(CONTRACTS.lpLocker, "get_locks_by_creator", [
    addressArg(address),
    ...paginationArgs(offset, limit),
  ])
  return enrichLpLocks(raw ?? [])
}

/**
 * List LP locks where a given address is the beneficiary, paginated
 * server-side by the contract's `ByBeneficiary` index.
 *
 * @param address - Stellar `G...`/`C...` address of the beneficiary.
 * @param offset - Zero-based index into the beneficiary's lock list to start from (default `0`).
 * @param limit - Maximum number of locks to return in this page (default {@link DEFAULT_PAGE_SIZE}).
 * @returns Enriched {@link Lock} objects (empty array if the address is not a beneficiary of any LP lock).
 * @throws {Error} `Simulation error: ...` if the read-only simulation fails.
 */
export async function getLpLocksByBeneficiary(address: string, offset = 0, limit = DEFAULT_PAGE_SIZE): Promise<Lock[]> {
  const raw = await simulateCall<Record<string, unknown>[]>(CONTRACTS.lpLocker, "get_locks_by_beneficiary", [
    addressArg(address),
    ...paginationArgs(offset, limit),
  ])
  return enrichLpLocks(raw ?? [])
}

/**
 * Count how many LP locks a given address has created (length of the on-chain
 * `ByCreator` index).
 *
 * @param address - Stellar `G...`/`C...` address of the lock creator.
 * @returns Total number of LP locks created by `address` (`0` if none).
 * @throws {Error} `Simulation error: ...` if the read-only simulation fails.
 */
export async function getLpLockCountByCreator(address: string): Promise<number> {
  const raw = await simulateCall<number>(CONTRACTS.lpLocker, "get_lock_count_by_creator", [addressArg(address)])
  return Number(raw ?? 0)
}

/**
 * Count how many LP locks a given address is the beneficiary of (length of the
 * on-chain `ByBeneficiary` index).
 *
 * @param address - Stellar `G...`/`C...` address of the beneficiary.
 * @returns Total number of LP locks where `address` is the beneficiary (`0` if none).
 * @throws {Error} `Simulation error: ...` if the read-only simulation fails.
 */
export async function getLpLockCountByBeneficiary(address: string): Promise<number> {
  const raw = await simulateCall<number>(CONTRACTS.lpLocker, "get_lock_count_by_beneficiary", [addressArg(address)])
  return Number(raw ?? 0)
}

// ── Write methods ─────────────────────────────────────────────────────────────

/**
 * Create a new LP (pool-share) lock on-chain: transfers `args.amount` of
 * `args.poolShareAddress` from `sourceAddress` into the contract, escrowed until
 * `args.unlockAt`. Requires `sourceAddress`'s signature (`creator.require_auth()`
 * on-chain) and a prior token allowance covering the transfer — call
 * {@link submitTokenApproval} first. Unlike token locks, LP locks have no vesting option.
 *
 * @param args - Lock parameters:
 *   - `poolShareAddress` — contract address of the DEX pool-share/LP token to lock.
 *   - `dex` — which DEX the pool belongs to (`"aquarius"` or `"soroswap"`), stored on-chain
 *     for display purposes only.
 *   - `tokenA` / `tokenB` — the pool's underlying asset pair addresses (informational, stored on-chain).
 *   - `amount` — human-readable amount (converted to stroops using 7 decimals).
 *   - `beneficiary` — address allowed to withdraw once unlocked.
 *   - `unlockAt` — unix seconds after which withdrawal becomes possible; must be in the future.
 *   - `metadata` — optional description/project/logo strings stored on-chain as plain text.
 * @param sourceAddress - Address of the wallet creating (and paying for) the lock; becomes `creator`.
 * @param signTransaction - Callback that signs the built transaction XDR with the user's wallet
 *   and returns the signed XDR.
 * @param onProgress - Optional callback invoked with each {@link TxPhase} as the transaction
 *   is built, signed, submitted, and confirmed.
 * @returns The newly created lock's `id` and the submission `txHash`.
 * @throws {Error} Wrapping one of the contract's `ContractError` variants, notably:
 *   - `AmountMustBePositive` (1) — `amount` is zero or negative.
 *   - `UnlockMustBeFuture` (2) — `unlockAt` is not after the current ledger time.
 * @throws {Error} `Simulation error: ...` / `Send error: ...` / `Transaction failed: ...` for
 *   RPC/network failures or an insufficient token allowance/balance on the transfer.
 */
export async function createLpLock(
  args: CreateLpLockArgs,
  sourceAddress: string,
  signTransaction: (xdr: string) => Promise<{ signedTxXdr: string }>,
  onProgress?: (phase: TxPhase) => void,
): Promise<{ id: string; txHash: string }> {
  const scArgs: xdr.ScVal[] = [
    addressArg(sourceAddress),
    addressArg(args.poolShareAddress),
    dexArg(args.dex),
    addressArg(args.tokenA),
    addressArg(args.tokenB),
    nativeToScVal(BigInt(Math.round(args.amount * 1e7)), { type: "i128" }),
    addressArg(args.beneficiary),
    nativeToScVal(BigInt(Math.floor(args.unlockAt)), { type: "u64" }),
    metadataArg(args.metadata),
  ]

  const { result: id, txHash } = await submitCallWithHash<bigint>(
    CONTRACTS.lpLocker,
    "create_lock",
    scArgs,
    sourceAddress,
    signTransaction,
    onProgress,
  )

  return { id: String(id), txHash }
}

/**
 * Withdraw the full locked amount of an LP lock. Callable only by the lock's
 * current `beneficiary` (`beneficiary.require_auth()` on-chain) once `unlockAt`
 * has passed. Unlike token locks there is no vesting/partial-release path — the
 * entire `amount` is transferred and the lock is marked withdrawn in one call.
 *
 * @param id - Numeric lock id (as a decimal string).
 * @param sourceAddress - Address submitting the transaction; must equal the lock's `beneficiary`.
 * @param signTransaction - Callback that signs the built transaction XDR and returns signed XDR.
 * @param onProgress - Optional callback invoked with each {@link TxPhase} during submission.
 * @returns The submission `txHash`.
 * @throws {Error} Wrapping one of the contract's `ContractError` variants, notably:
 *   - `AlreadyWithdrawn` (3) — the lock has already been withdrawn.
 *   - `StillLocked` (4) — called before `unlockAt`.
 * @throws {Error} `Simulation error: ...` / `Send error: ...` / `Transaction failed: ...` if
 *   `sourceAddress` fails `require_auth` as beneficiary, or for RPC/network failures.
 */
export async function withdrawLpLock(
  id: string,
  sourceAddress: string,
  signTransaction: (xdr: string) => Promise<{ signedTxXdr: string }>,
  onProgress?: (phase: TxPhase) => void,
): Promise<{ txHash: string }> {
  const { txHash } = await submitCallWithHash<void>(
    CONTRACTS.lpLocker,
    "withdraw",
    [idArg(id)],
    sourceAddress,
    signTransaction,
    onProgress,
  )
  return { txHash }
}

/**
 * Push an LP lock's unlock date further into the future. Callable only by the
 * lock's `creator` (`creator.require_auth()` on-chain); the new date must be
 * strictly later than the current `unlockAt`. Increments the lock's `extendedCount`.
 *
 * @param id - Numeric lock id (as a decimal string).
 * @param newUnlockAt - New unlock unix-second timestamp; must be greater than the lock's current `unlockAt`.
 * @param sourceAddress - Address submitting the transaction; must equal the lock's `creator`.
 * @param signTransaction - Callback that signs the built transaction XDR and returns signed XDR.
 * @param onProgress - Optional callback invoked with each {@link TxPhase} during submission.
 * @returns The submission `txHash`.
 * @throws {Error} Wrapping one of the contract's `ContractError` variants, notably:
 *   - `AlreadyWithdrawn` (3) — the lock has already been withdrawn.
 *   - `CanOnlyExtend` (5) — `newUnlockAt` is not strictly later than the current `unlockAt`.
 * @throws {Error} `Simulation error: ...` / `Send error: ...` / `Transaction failed: ...` if
 *   `sourceAddress` fails `require_auth` as creator, or for RPC/network failures.
 */
export async function extendLpLock(
  id: string,
  newUnlockAt: number,
  sourceAddress: string,
  signTransaction: (xdr: string) => Promise<{ signedTxXdr: string }>,
  onProgress?: (phase: TxPhase) => void,
): Promise<{ txHash: string }> {
  const { txHash } = await submitCallWithHash<void>(
    CONTRACTS.lpLocker,
    "extend",
    [idArg(id), nativeToScVal(BigInt(Math.floor(newUnlockAt)), { type: "u64" })],
    sourceAddress,
    signTransaction,
    onProgress,
  )
  return { txHash }
}

/**
 * Transfer the beneficiary role of an LP lock to a new address. Callable only
 * by the lock's current `beneficiary` (`beneficiary.require_auth()` on-chain);
 * the creator cannot reassign the beneficiary. Updates the on-chain
 * `ByBeneficiary` index so the new beneficiary's lock listings include this
 * lock and the old beneficiary's do not.
 *
 * @param id - Numeric lock id (as a decimal string).
 * @param newBeneficiary - Stellar address to become the new beneficiary.
 * @param sourceAddress - Address submitting the transaction; must equal the lock's current `beneficiary`.
 * @param signTransaction - Callback that signs the built transaction XDR and returns signed XDR.
 * @param onProgress - Optional callback invoked with each {@link TxPhase} during submission.
 * @returns The submission `txHash`.
 * @throws {Error} Wrapping one of the contract's `ContractError` variants, notably:
 *   - `AlreadyWithdrawn` (3) — the lock has already been withdrawn and can no longer be reassigned.
 * @throws {Error} `Simulation error: ...` / `Send error: ...` / `Transaction failed: ...` if
 *   `sourceAddress` fails `require_auth` as beneficiary, or for RPC/network failures.
 */
export async function transferLpBeneficiary(
  id: string,
  newBeneficiary: string,
  sourceAddress: string,
  signTransaction: (xdr: string) => Promise<{ signedTxXdr: string }>,
  onProgress?: (phase: TxPhase) => void,
): Promise<{ txHash: string }> {
  const { txHash } = await submitCallWithHash<void>(
    CONTRACTS.lpLocker,
    "transfer_beneficiary",
    [idArg(id), addressArg(newBeneficiary)],
    sourceAddress,
    signTransaction,
    onProgress,
  )
  return { txHash }
}
