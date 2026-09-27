import {
  Address,
  Contract,
  Networks,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk"

import { getContractAddress } from "@/lib/contracts.generated"
import { createLogger } from "@/lib/logger"
import { getOnChainTokenMeta } from "@/lib/token-metadata"
import { resolveNetworkKey } from "@/lib/network-key"

const log = createLogger("stellar")

// Issue #742: derive from the shared resolveNetworkKey() instead of
// re-implementing the testnet/staging/mainnet mapping here — this used to
// treat "staging" as testnet while useVerifiedToken treated it as mainnet,
// a real cross-module inconsistency (staging deploys against mainnet
// contracts, so its RPC/passphrase must match).
const isMainnet = resolveNetworkKey() === "mainnet"

const defaultRpcUrl = isMainnet ? "https://soroban-mainnet.stellar.org" : "https://soroban-testnet.stellar.org"
const defaultHorizonUrl = isMainnet ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org"

export const NETWORK = {
  id: isMainnet ? "mainnet" : "testnet",
  passphrase: isMainnet ? Networks.PUBLIC : Networks.TESTNET,
  rpcUrl: import.meta.env.VITE_RPC_URL || defaultRpcUrl,
  horizonUrl: import.meta.env.VITE_HORIZON_URL || defaultHorizonUrl,
  networkName: isMainnet ? "public" : "testnet",
  displayName: isMainnet ? "Mainnet" : "Testnet",
}

export const CONTRACTS = {
  tokenLocker: getContractAddress("token-locker"),
  lpLocker: getContractAddress("lp-locker"),
}

// Soroban transactions need a higher base fee than classic Stellar
const SOROBAN_FEE = "1000000" // 0.1 XLM — covers resource fees

export const STELLAR_DECIMALS = 1e7 // Stellar tokens use 7 decimal places
const POLL_INTERVAL_MS = 1500
const MAX_CONCURRENT = 5
const MAX_RETRIES = 3
const CACHE_TTL_MS = 10_000

/** Phase reported via the onProgress callback during submitCall. */
export type TxPhase = "simulating" | "signing" | "submitting" | "confirming"

// ── RPC client ────────────────────────────────────────────────────────────────

type SimulateArg = Parameters<SorobanRpc.Server["simulateTransaction"]>[0]

class RpcClient {
  private readonly server: SorobanRpc.Server
  // In-flight deduplication: cache key → promise
  private readonly inflight = new Map<string, Promise<SorobanRpc.Api.SimulateTransactionResponse>>()
  // Response cache: cache key → { data, expiry }
  private readonly cache = new Map<string, { data: SorobanRpc.Api.SimulateTransactionResponse; expiry: number }>()
  private activeCount = 0
  private readonly queue: Array<() => void> = []

  constructor(rpcUrl: string) {
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false })
  }

  getServer(): SorobanRpc.Server {
    return this.server
  }

  private async withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount < MAX_CONCURRENT) {
      this.activeCount++
      try {
        return await fn()
      } finally {
        this.activeCount--
        const next = this.queue.shift()
        if (next) next()
      }
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        void (async () => {
          this.activeCount++
          try {
            resolve(await fn())
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          } finally {
            this.activeCount--
            const next = this.queue.shift()
            if (next) next()
          }
        })()
      })
    })
  }

  private async retrySimulate(tx: SimulateArg): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.withConcurrencyLimit(() => this.server.simulateTransaction(tx))
      } catch (err) {
        lastErr = err
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
        }
      }
    }
    throw lastErr
  }

  // cacheKey must be caller-supplied rather than derived from tx.toXDR():
  // TransactionBuilder.setTimeout() bakes the current wall-clock time into
  // timeBounds.maxTime, so the XDR of an otherwise-identical call changes
  // every second and would defeat both caching and dedup almost entirely.
  async simulate(
    tx: SimulateArg,
    cacheKey: string,
    cacheTtlMs = CACHE_TTL_MS,
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    const key = cacheKey

    // Cache hit
    const cached = this.cache.get(key)
    if (cached && cached.expiry > Date.now()) {
      return cached.data
    }

    // Dedup in-flight
    const existing = this.inflight.get(key)
    if (existing) return existing

    const promise = this.retrySimulate(tx)
      .then((data) => {
        if (cacheTtlMs > 0) {
          this.cache.set(key, { data, expiry: Date.now() + cacheTtlMs })
        }
        this.inflight.delete(key)
        return data
      })
      .catch((err) => {
        this.inflight.delete(key)
        throw err
      })

    this.inflight.set(key, promise)
    return promise
  }

  invalidateCache(): void {
    this.cache.clear()
    // In-flight requests are not cancelled; stale results will simply not be
    // re-cached because the next simulate() call will miss a cold cache.
  }
}

let _client: RpcClient | null = null
function getClient(): RpcClient {
  if (!_client) _client = new RpcClient(NETWORK.rpcUrl)
  return _client
}

// Keep backward-compat export used elsewhere in the codebase
export function getRpc(): SorobanRpc.Server {
  return getClient().getServer()
}

// Invalidate read cache after mutations (create, withdraw, extend)
export function invalidateRpcCache(): void {
  getClient().invalidateCache()
}

function simError(result: unknown): string {
  // Extract a readable string from whatever shape the sim error takes
  if (!result || typeof result !== "object") return String(result)
  const r = result as Record<string, unknown>
  if (typeof r.error === "string") return r.error
  if (typeof r.error === "object") return JSON.stringify(r.error)
  return JSON.stringify(r)
}

// ── Simulate (read-only) ──────────────────────────────────────────────────────

export async function simulateCall<T>(contractId: string, method: string, args: xdr.ScVal[]): Promise<T> {
  const client = getClient()

  const dummySource = {
    accountId: () => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    sequenceNumber: () => "0",
    incrementSequenceNumber: () => {},
  }

  const contract = new Contract(contractId)
  const tx = new TransactionBuilder(dummySource, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const cacheKey = `${contractId}:${method}:${args.map((a) => a.toXDR("base64")).join(",")}`
  const result = await client.simulate(tx, cacheKey)
  log.debug("[simulateCall]", { method, result })

  if (SorobanRpc.Api.isSimulationError(result)) {
    throw new Error(`Simulation error: ${simError(result)}`)
  }

  const retval = result.result?.retval
  if (!retval) return undefined as T
  return scValToNative(retval) as T
}

// ── Submit (write) ────────────────────────────────────────────────────────────

export async function submitCall<T = void>(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  sourceAddress: string,
  signTransaction: (xdr: string) => Promise<{ signedTxXdr: string }>,
  onProgress?: (phase: TxPhase) => void,
): Promise<T> {
  const rpc = getRpc()
  const account = await rpc.getAccount(sourceAddress)
  const contract = new Contract(contractId)

  const tx = new TransactionBuilder(account, {
    fee: SOROBAN_FEE,
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  onProgress?.("simulating")
  const simResult = await rpc.simulateTransaction(tx)
  log.debug("[submitCall sim]", { method, simResult })

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation error: ${simError(simResult)}`)
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build()

  onProgress?.("signing")
  const { signedTxXdr } = await signTransaction(preparedTx.toXDR())

  onProgress?.("submitting")
  const sendResult = await rpc.sendTransaction(TransactionBuilder.fromXDR(signedTxXdr, NETWORK.passphrase))
  log.debug("[submitCall send]", { sendResult })

  if (sendResult.status === "ERROR") {
    throw new Error(`Send error: ${sendResult.errorResult?.toXDR("base64") ?? "unknown"}`)
  }

  // Invalidate read cache now that a mutation has been submitted successfully
  invalidateRpcCache()

  onProgress?.("confirming")
  const MAX_POLL_ATTEMPTS = 40
  let getResult = await rpc.getTransaction(sendResult.hash)
  for (let attempts = 0; getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND; attempts++) {
    if (attempts >= MAX_POLL_ATTEMPTS) {
      throw new Error(`Transaction ${sendResult.hash} not found after ${MAX_POLL_ATTEMPTS} attempts (~60s)`)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    getResult = await rpc.getTransaction(sendResult.hash)
  }
  log.debug("[submitCall result]", { getResult })

  if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error(`Transaction failed: ${JSON.stringify(getResult)}`)
  }

  if (getResult.returnValue) {
    return scValToNative(getResult.returnValue) as T
  }

  return undefined as T
}

// ── submitCallWithHash — like submitCall but also returns the tx hash ─────────

/** Same as submitCall, but additionally returns the transaction hash. */
export async function submitCallWithHash<T = void>(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  sourceAddress: string,
  signTransaction: (xdr: string) => Promise<{ signedTxXdr: string }>,
  onProgress?: (phase: TxPhase) => void,
): Promise<{ result: T; txHash: string }> {
  const rpc = getRpc()
  const account = await rpc.getAccount(sourceAddress)
  const contract = new Contract(contractId)

  const tx = new TransactionBuilder(account, {
    fee: SOROBAN_FEE,
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  onProgress?.("simulating")
  const simResult = await rpc.simulateTransaction(tx)

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation error: ${simError(simResult)}`)
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build()

  onProgress?.("signing")
  const { signedTxXdr } = await signTransaction(preparedTx.toXDR())

  onProgress?.("submitting")
  const sendResult = await rpc.sendTransaction(TransactionBuilder.fromXDR(signedTxXdr, NETWORK.passphrase))

  if (sendResult.status === "ERROR") {
    throw new Error(`Send error: ${sendResult.errorResult?.toXDR("base64") ?? "unknown"}`)
  }

  const txHash = sendResult.hash

  invalidateRpcCache()

  onProgress?.("confirming")
  const MAX_POLL_ATTEMPTS = 40
  let getResult = await rpc.getTransaction(txHash)
  for (let attempts = 0; getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND; attempts++) {
    if (attempts >= MAX_POLL_ATTEMPTS) {
      throw new Error(`Transaction ${txHash} not found after ${MAX_POLL_ATTEMPTS} attempts (~60s)`)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    getResult = await rpc.getTransaction(txHash)
  }

  if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error(`Transaction failed: ${JSON.stringify(getResult)}`)
  }

  const result = getResult.returnValue ? (scValToNative(getResult.returnValue) as T) : (undefined as T)
  return { result, txHash }
}

// ── Address helpers ─────────────────────────────────────────────────────────

// Defined in @/lib/stellar-address so they can be imported without pulling in the
// env validation and RPC client this module sets up at import time.
export { isValidStellarAddress, isValidStellarContractAddress, isValidStellarPublicKey } from "@/lib/stellar-address"

// ── Cost estimation ───────────────────────────────────────────────────────────

export interface LockCostEstimate {
  networkFee: number // in XLM
  resourceFee: number // in XLM (storage deposit + compute)
  total: number // in XLM
}

export async function estimateLockCost(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<LockCostEstimate> {
  const rpc = getRpc()

  const dummySource = {
    accountId: () => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    sequenceNumber: () => "0",
    incrementSequenceNumber: () => {},
  }

  const contract = new Contract(contractId)
  const tx = new TransactionBuilder(dummySource, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const result = await rpc.simulateTransaction(tx)
  log.debug("[estimateLockCost]", { method, result })

  if (SorobanRpc.Api.isSimulationError(result)) {
    throw new Error(`Cost simulation failed: ${simError(result)}`)
  }

  const minResourceFee = Number((result as { minResourceFee?: string }).minResourceFee ?? "0")
  const networkFee = Number(BASE_FEE) / 1e7
  const resourceFee = minResourceFee / 1e7
  return { networkFee, resourceFee, total: networkFee + resourceFee }
}

// ── Token helpers ────────────────────────────────────────────────────────────

export async function getTokenBalance(tokenAddress: string, owner: string): Promise<number> {
  const raw = await simulateCall<bigint>(tokenAddress, "balance", [new Address(owner).toScVal()])
  const { decimals } = await getOnChainTokenMeta(tokenAddress)
  return Number(raw ?? 0n) / 10 ** decimals
}

export async function getTokenAllowance(tokenAddress: string, owner: string, spender: string): Promise<number> {
  const raw = await simulateCall<bigint>(tokenAddress, "allowance", [
    new Address(owner).toScVal(),
    new Address(spender).toScVal(),
  ])
  const { decimals } = await getOnChainTokenMeta(tokenAddress)
  return Number(raw ?? 0n) / 10 ** decimals
}

export async function submitTokenApproval(
  tokenAddress: string,
  owner: string,
  spender: string,
  amount: number,
  sourceAddress: string,
  signTransaction: (xdr: string) => Promise<{ signedTxXdr: string }>,
): Promise<void> {
  const amountStroops = BigInt(Math.round(amount * 1e7))
  const expirationLedger = 0

  const scArgs: xdr.ScVal[] = [
    new Address(owner).toScVal(),
    new Address(spender).toScVal(),
    nativeToScVal(amountStroops, { type: "i128" }),
    nativeToScVal(expirationLedger, { type: "u32" }),
  ]

  await submitCall(tokenAddress, "approve", scArgs, sourceAddress, signTransaction)
}

// ── Utils ─────────────────────────────────────────────────────────────────────

export function explorerLink(address: string): string {
  return `https://stellar.expert/explorer/${NETWORK.networkName}/contract/${address}`
}

export function txExplorerLink(hash: string): string {
  return `https://stellar.expert/explorer/${NETWORK.networkName}/tx/${hash}`
}
