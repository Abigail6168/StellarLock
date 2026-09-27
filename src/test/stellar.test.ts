import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { rpc as SorobanRpc, nativeToScVal } from "@stellar/stellar-sdk"
import { getTokenAllowance, getTokenBalance, invalidateRpcCache, simulateCall } from "@/lib/stellar"
import { getOnChainTokenMeta } from "@/lib/token-metadata"

// Mock the token-metadata module so we can control the on-chain decimals that
// getTokenBalance / getTokenAllowance use for the raw-amount → whole-token
// conversion (regression for #509).
vi.mock("@/lib/token-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/token-metadata")>()
  return {
    ...actual,
    getOnChainTokenMeta: vi.fn(),
  }
})

// Real success responses have several fields; the RpcClient (and the
// isSimulationError() check it relies on) only cares that "error" is absent.
const SUCCESS_RESULT = {} as SorobanRpc.Api.SimulateTransactionResponse

const CONTRACT_ID = "CBFCKEOQRQIXKLGU4QBUQVOINOKFBOXJ37LXEKLKNUO6TW4FNGDU26AW"

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: ((value: T) => void) | undefined
  const promise = new Promise<T>((res) => {
    resolveFn = res
  })
  return { promise, resolve: (value: T) => resolveFn?.(value) }
}

function spyOnSimulateTransaction() {
  return vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction")
}

describe("RpcClient (exercised via simulateCall) — caching, dedup, rate limiting", () => {
  let simulateSpy: ReturnType<typeof spyOnSimulateTransaction>

  beforeEach(() => {
    // Frozen clock so cache-TTL boundaries can be advanced precisely.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    invalidateRpcCache()
    simulateSpy = spyOnSimulateTransaction()
  })

  afterEach(() => {
    simulateSpy.mockRestore()
    vi.useRealTimers()
  })

  it("dedupes identical concurrent calls into a single underlying RPC request", async () => {
    const gate = deferred<SorobanRpc.Api.SimulateTransactionResponse>()
    simulateSpy.mockReturnValue(gate.promise)

    const call1 = simulateCall(CONTRACT_ID, "get_lock", [])
    const call2 = simulateCall(CONTRACT_ID, "get_lock", [])
    await vi.advanceTimersByTimeAsync(0)

    // Both calls should share the one in-flight request, not fire two.
    expect(simulateSpy).toHaveBeenCalledTimes(1)

    gate.resolve(SUCCESS_RESULT)
    await Promise.all([call1, call2])

    expect(simulateSpy).toHaveBeenCalledTimes(1)
  })

  it("does not dedupe distinct calls", async () => {
    simulateSpy.mockResolvedValue(SUCCESS_RESULT)

    await Promise.all([simulateCall(CONTRACT_ID, "get_lock", []), simulateCall(CONTRACT_ID, "get_other_lock", [])])

    expect(simulateSpy).toHaveBeenCalledTimes(2)
  })

  it("serves cached responses within the TTL without a second network call", async () => {
    simulateSpy.mockResolvedValue(SUCCESS_RESULT)

    await simulateCall(CONTRACT_ID, "get_lock", [])
    expect(simulateSpy).toHaveBeenCalledTimes(1)

    // Still within the 10s cache TTL - should be a cache hit.
    await vi.advanceTimersByTimeAsync(9_000)
    await simulateCall(CONTRACT_ID, "get_lock", [])
    expect(simulateSpy).toHaveBeenCalledTimes(1)

    // Past the TTL - should re-fetch.
    await vi.advanceTimersByTimeAsync(2_000)
    await simulateCall(CONTRACT_ID, "get_lock", [])
    expect(simulateSpy).toHaveBeenCalledTimes(2)
  })

  it("invalidateRpcCache() forces a fresh network call even within the TTL", async () => {
    simulateSpy.mockResolvedValue(SUCCESS_RESULT)

    await simulateCall(CONTRACT_ID, "get_lock", [])
    expect(simulateSpy).toHaveBeenCalledTimes(1)

    invalidateRpcCache()

    await simulateCall(CONTRACT_ID, "get_lock", [])
    expect(simulateSpy).toHaveBeenCalledTimes(2)
  })

  it("caps concurrent in-flight requests at 5 and queues the rest", async () => {
    const gates = Array.from({ length: 6 }, () => deferred<SorobanRpc.Api.SimulateTransactionResponse>())
    let callIndex = 0
    simulateSpy.mockImplementation(() => gates[callIndex++].promise)

    // Distinct methods so none of these share a cache/dedup key.
    const calls = gates.map((_, i) => simulateCall(CONTRACT_ID, `method_${i}`, []))
    await vi.advanceTimersByTimeAsync(0)

    // Only MAX_CONCURRENT (5) should have reached the network; the 6th queues.
    expect(simulateSpy).toHaveBeenCalledTimes(5)

    // Draining one in-flight request frees a slot for the queued 6th call.
    gates[0].resolve(SUCCESS_RESULT)
    await vi.advanceTimersByTimeAsync(0)
    expect(simulateSpy).toHaveBeenCalledTimes(6)

    gates.slice(1).forEach((g) => g.resolve(SUCCESS_RESULT))
    await Promise.all(calls)
  })
})

// ── #509: getTokenBalance / getTokenAllowance use per-token decimals ─────────
describe("getTokenBalance / getTokenAllowance decimals conversion (#509)", () => {
  const TOKEN_ADDRESS = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
  const OWNER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
  const SPENDER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"

  let simulateSpy: ReturnType<typeof spyOnSimulateTransaction>
  let metaMock: ReturnType<typeof vi.fn>

  // Wrap a raw on-chain i128 value in the same response shape simulateCall
  // reads (`result.retval`, converted via scValToNative). Each test controls
  // the raw units and the mocked decimals so the conversion divides by
  // 10 ** decimals, not the old hard-coded 1e7.
  function rawResult(raw: bigint): SorobanRpc.Api.SimulateTransactionResponse {
    return {
      result: {
        retval: nativeToScVal(raw, { type: "i128" }),
      },
    } as unknown as SorobanRpc.Api.SimulateTransactionResponse
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    invalidateRpcCache()
    simulateSpy = spyOnSimulateTransaction()
    metaMock = vi.mocked(getOnChainTokenMeta)
    metaMock.mockReset()
    // Default: the existing 7-decimal path (e.g. native XLM-wrapped assets).
    metaMock.mockResolvedValue({ symbol: "XLM", name: "Stellar Lumens", decimals: 7 })
  })

  afterEach(() => {
    simulateSpy.mockRestore()
    metaMock.mockReset()
    vi.useRealTimers()
  })

  it("divides a 6-decimal token's raw balance by 10^6, not 1e7 (balance)", async () => {
    metaMock.mockResolvedValue({ symbol: "USDC", name: "USD Coin", decimals: 6 })
    simulateSpy.mockResolvedValue(rawResult(1_234_567n)) // 1.234567 USDC

    const balance = await getTokenBalance(TOKEN_ADDRESS, OWNER)

    expect(balance).toBeCloseTo(1.234567, 6)
    // The old hard-coded value (1e7) would have produced 0.1234567.
    expect(balance).not.toBeCloseTo(0.1234567, 6)
  })

  it("keeps 7-decimal tokens unchanged (balance)", async () => {
    simulateSpy.mockResolvedValue(rawResult(12_345_678n)) // 1.2345678 XLM

    const balance = await getTokenBalance(TOKEN_ADDRESS, OWNER)

    expect(balance).toBeCloseTo(1.2345678, 6)
  })

  it("divides a 6-decimal token's raw allowance by 10^6, not 1e7 (allowance)", async () => {
    metaMock.mockResolvedValue({ symbol: "USDC", name: "USD Coin", decimals: 6 })
    simulateSpy.mockResolvedValue(rawResult(500_000n)) // 0.5 USDC allowance

    const allowance = await getTokenAllowance(TOKEN_ADDRESS, OWNER, SPENDER)

    expect(allowance).toBeCloseTo(0.5, 6)
    expect(allowance).not.toBeCloseTo(0.05, 6)
  })

  it("keeps 7-decimal tokens unchanged (allowance)", async () => {
    simulateSpy.mockResolvedValue(rawResult(7_000_000n)) // 0.7 XLM allowance

    const allowance = await getTokenAllowance(TOKEN_ADDRESS, OWNER, SPENDER)

    expect(allowance).toBeCloseTo(0.7, 6)
  })

  it("converts an 18-decimal token correctly (large divisor beyond stroops)", async () => {
    metaMock.mockResolvedValue({ symbol: "WETH", name: "Wrapped Ether", decimals: 18 })
    // 1.5e18 raw units → 1.5 whole tokens
    simulateSpy.mockResolvedValue(rawResult(1_500_000_000_000_000_000n))

    const balance = await getTokenBalance(TOKEN_ADDRESS, OWNER)

    expect(balance).toBeCloseTo(1.5, 6)
  })
})

// ── #742: NETWORK treats "staging" as mainnet, consistent with useVerifiedToken ──
// NETWORK is computed once at module import time from VITE_NETWORK, so each
// test here re-imports the module fresh after stubbing the env var (same
// pattern used in env.test.ts).
describe("NETWORK resolution (#742)", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    // Restore (not unstub-all) — this test file's other describe blocks,
    // and src/test/setup.ts's global stubs, rely on VITE_RPC_URL etc.
    // staying set; vi.unstubAllEnvs() would wipe those too.
    vi.stubEnv("VITE_NETWORK", "TESTNET")
  })

  it('treats VITE_NETWORK="staging" as mainnet, not testnet', async () => {
    vi.stubEnv("VITE_NETWORK", "staging")
    const { Networks } = await import("@stellar/stellar-sdk")
    const { NETWORK } = await import("@/lib/stellar")

    // Before this fix, staging resolved to testnet here while
    // useVerifiedToken already treated it as mainnet — a real cross-module
    // inconsistency, since staging's own .env file points RPC/Horizon at
    // mainnet infrastructure.
    expect(NETWORK.id).toBe("mainnet")
    expect(NETWORK.passphrase).toBe(Networks.PUBLIC)
  })

  it('still treats VITE_NETWORK="testnet" as testnet', async () => {
    vi.stubEnv("VITE_NETWORK", "testnet")
    const { Networks } = await import("@stellar/stellar-sdk")
    const { NETWORK } = await import("@/lib/stellar")

    expect(NETWORK.id).toBe("testnet")
    expect(NETWORK.passphrase).toBe(Networks.TESTNET)
  })
})
