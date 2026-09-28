import { describe, it, expect, vi, beforeEach } from "vitest"
import { scValToNative } from "@stellar/stellar-sdk"
import {
  getLpLock,
  getLpLocksByCreator,
  getLpLocksByBeneficiary,
  getLpLockCountByCreator,
  getLpLockCountByBeneficiary,
  createLpLock,
  withdrawLpLock,
  extendLpLock,
  transferLpBeneficiary,
  submitTokenApproval,
} from "@/lib/lp-locker"
import { xdr } from "@stellar/stellar-sdk"

const LP_LOCKER_ADDR = "CABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVX"
const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
const VALID_BENEFICIARY = "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL"
const VALID_TOKEN = "CBFCKEOQRQIXKLGU4QBUQVOINOKFBOXJ37LXEKLKNUO6TW4FNGDU26AW"
const TOKEN_A = "CAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDQF"
const TOKEN_B = "CABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARHO"

const { simulateCall, submitCall, submitCallWithHash, getOnChainTokenMeta } = vi.hoisted(() => ({
  simulateCall: vi.fn(),
  submitCall: vi.fn(),
  submitCallWithHash: vi.fn(),
  getOnChainTokenMeta: vi.fn(),
}))

vi.mock("@/lib/stellar", () => ({
  CONTRACTS: { lpLocker: "CABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVX" },
  simulateCall,
  submitCall,
  submitCallWithHash,
}))

vi.mock("@/lib/token-metadata", () => ({
  getOnChainTokenMeta,
}))

// A raw LP lock as returned by scValToNative from the contract's `get_lock`
// etc — numeric/timestamp fields come back as bigint, extended_count as a
// plain number, dex as a contracttype enum object ({ tag }) or string.
function rawLpLock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7n,
    pool_share: VALID_TOKEN,
    dex: { tag: "Aquarius" },
    token_a: TOKEN_A,
    token_b: TOKEN_B,
    creator: VALID_ADDRESS,
    beneficiary: VALID_BENEFICIARY,
    amount: 500_0000000n, // 500 tokens at 7 decimals
    withdrawn: false,
    created_at: 1_700_000_000n,
    unlock_at: 9_999_999_999n, // far future
    extended_count: 2,
    metadata: { description: "", project_url: "", logo_url: "" },
    ...overrides,
  }
}

describe("lp-locker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getOnChainTokenMeta.mockResolvedValue({ symbol: "TOK", name: "Token", decimals: 7 })
  })

  // ── Read methods ────────────────────────────────────────────────────────────

  describe("getLpLock", () => {
    it("returns null when the contract has no lock with that id", async () => {
      simulateCall.mockResolvedValue(null)
      const lock = await getLpLock("42")
      expect(lock).toBeNull()
      expect(getOnChainTokenMeta).not.toHaveBeenCalled()
    })

    it("calls simulateCall with the lp locker contract and get_lock method", async () => {
      simulateCall.mockResolvedValue(rawLpLock())
      await getLpLock("42")
      expect(simulateCall).toHaveBeenCalledTimes(1)
      expect(simulateCall.mock.calls[0][0]).toBe(LP_LOCKER_ADDR)
      expect(simulateCall.mock.calls[0][1]).toBe("get_lock")
    })

    it("maps a raw LP lock into the Lock shape, converting stroops and timestamps", async () => {
      simulateCall.mockResolvedValue(rawLpLock())
      const lock = await getLpLock("7")

      expect(lock).not.toBeNull()
      expect(lock!.id).toBe("7")
      expect(lock!.kind).toBe("lp")
      expect(lock!.amount).toBe(500) // 500_0000000n / 1e7
      expect(lock!.createdAt).toBe(1_700_000_000_000) // seconds -> ms
      expect(lock!.unlockAt).toBe(9_999_999_999_000)
      expect(lock!.extendedCount).toBe(2)
      expect(lock!.dex).toBe("aquarius")
      expect(lock!.poolPair).toEqual([TOKEN_A, TOKEN_B])
      expect(lock!.token.address).toBe(VALID_TOKEN)
    })

    it("derives the LP token symbol from pool pair when no metadata is passed", async () => {
      simulateCall.mockResolvedValue(rawLpLock())
      const lock = await getLpLock("7")
      // tokenA.slice(0,4) + "-" + tokenB.slice(0,4) + " LP"
      expect(lock!.token.symbol).toBe("CAAQ-CABA LP")
      expect(lock!.token.decimals).toBe(7) // default pool decimals
    })

    it("derives status: withdrawn takes priority over the unlock timestamp", async () => {
      simulateCall.mockResolvedValue(rawLpLock({ withdrawn: true, unlock_at: 1n }))
      const lock = await getLpLock("7")
      expect(lock!.status).toBe("withdrawn")
    })

    it("derives status: unlockable once unlock_at has passed", async () => {
      simulateCall.mockResolvedValue(rawLpLock({ withdrawn: false, unlock_at: 1n })) // 1970, long past
      const lock = await getLpLock("7")
      expect(lock!.status).toBe("unlockable")
    })

    it("derives status: locked while unlock_at is still in the future", async () => {
      simulateCall.mockResolvedValue(rawLpLock({ withdrawn: false, unlock_at: 9_999_999_999n }))
      const lock = await getLpLock("7")
      expect(lock!.status).toBe("locked")
    })

    it("parses dex given as a plain string variant", async () => {
      simulateCall.mockResolvedValue(rawLpLock({ dex: "Soroswap" }))
      const lock = await getLpLock("7")
      expect(lock!.dex).toBe("soroswap")
    })

    it("omits metadata when all fields are empty strings", async () => {
      simulateCall.mockResolvedValue(rawLpLock())
      const lock = await getLpLock("7")
      expect(lock!.metadata).toBeUndefined()
    })

    it("includes metadata when at least one field is set", async () => {
      simulateCall.mockResolvedValue(
        rawLpLock({ metadata: { description: "liquidity incentive", project_url: "https://a.com", logo_url: "" } }),
      )
      const lock = await getLpLock("7")
      expect(lock!.metadata).toEqual({
        description: "liquidity incentive",
        projectUrl: "https://a.com",
        logoUrl: "",
      })
    })
  })

  describe("getLpLocksByCreator / getLpLocksByBeneficiary", () => {
    it("passes address and pagination args through and enriches results with on-chain metadata", async () => {
      simulateCall.mockResolvedValue([rawLpLock({ id: 1n }), rawLpLock({ id: 2n })])
      getOnChainTokenMeta.mockImplementation((addr: string) =>
        addr === TOKEN_A
          ? { symbol: "AAA", name: "Token A", decimals: 7 }
          : addr === TOKEN_B
            ? { symbol: "BBB", name: "Token B", decimals: 7 }
            : { symbol: "POOL", name: "Pool Share", decimals: 6 },
      )
      const locks = await getLpLocksByCreator(VALID_ADDRESS, 10, 20)

      expect(simulateCall.mock.calls[0][1]).toBe("get_locks_by_creator")
      expect(simulateCall.mock.calls[0][2]).toBeDefined() // address scval
      expect(locks).toHaveLength(2)
      expect(locks.map((l) => l.id)).toEqual(["1", "2"])
      // Unique addresses: token_a, token_b, pool_share
      expect(getOnChainTokenMeta).toHaveBeenCalledTimes(3)
      expect(locks[0].token.symbol).toBe("AAA-BBB LP")
      expect(locks[0].token.decimals).toBe(6) // pool-share decimals win
    })

    it("returns an empty array when the contract returns null", async () => {
      simulateCall.mockResolvedValue(null)
      const locks = await getLpLocksByBeneficiary(VALID_BENEFICIARY)
      expect(locks).toEqual([])
      expect(getOnChainTokenMeta).not.toHaveBeenCalled()
    })
  })

  describe("count methods", () => {
    it.each([
      ["getLpLockCountByCreator", getLpLockCountByCreator, "get_lock_count_by_creator"],
      ["getLpLockCountByBeneficiary", getLpLockCountByBeneficiary, "get_lock_count_by_beneficiary"],
    ] as const)("%s calls the matching contract method and coerces to a number", async (_name, fn, method) => {
      simulateCall.mockResolvedValue(7)
      const count = await fn(VALID_ADDRESS)
      expect(count).toBe(7)
      expect(simulateCall.mock.calls[0][1]).toBe(method)
    })

    it("defaults to 0 when the contract returns nothing", async () => {
      simulateCall.mockResolvedValue(undefined)
      expect(await getLpLockCountByCreator(VALID_ADDRESS)).toBe(0)
    })
  })

  // ── Write methods ───────────────────────────────────────────────────────────

  describe("submitTokenApproval", () => {
    it("submits approve on the token contract with stroops amount and zero expiration ledger", async () => {
      submitCall.mockResolvedValue(undefined)
      const signTx = vi.fn().mockResolvedValue({ signedTxXdr: "AAAA" })

      await submitTokenApproval(VALID_TOKEN, VALID_ADDRESS, LP_LOCKER_ADDR, 250, VALID_ADDRESS, signTx)

      expect(submitCall).toHaveBeenCalledTimes(1)
      expect(submitCall.mock.calls[0][0]).toBe(VALID_TOKEN)
      expect(submitCall.mock.calls[0][1]).toBe("approve")
      expect(submitCall.mock.calls[0][3]).toBe(VALID_ADDRESS)
      expect(submitCall.mock.calls[0][4]).toBe(signTx)

      const scArgs = submitCall.mock.calls[0][2] as xdr.ScVal[]
      expect(scArgs).toHaveLength(4)
      // owner, spender, amount (i128 stroops), expiration (u32 = 0)
      expect(scValToNative(scArgs[0])).toBe(VALID_ADDRESS)
      expect(scValToNative(scArgs[1])).toBe(LP_LOCKER_ADDR)
      expect(scValToNative(scArgs[2])).toBe(250_0000000n)
      expect(scValToNative(scArgs[3])).toBe(0)
    })

    it("scales the approved amount using the token's real decimals, not a hardcoded 7 (#740)", async () => {
      submitCall.mockResolvedValue(undefined)
      getOnChainTokenMeta.mockResolvedValue({ symbol: "W18", name: "Wide Token", decimals: 18 })
      const signTx = vi.fn().mockResolvedValue({ signedTxXdr: "AAAA" })

      await submitTokenApproval(VALID_TOKEN, VALID_ADDRESS, LP_LOCKER_ADDR, 2.5, VALID_ADDRESS, signTx)

      const scArgs = submitCall.mock.calls[0][2] as xdr.ScVal[]
      // Correct at 18 decimals: 2_500_000_000_000_000_000n.
      // The old hardcoded-7-decimals bug would have produced 25_000_000n instead.
      expect(scValToNative(scArgs[2])).toBe(2_500_000_000_000_000_000n)
    })
  })

  describe("createLpLock", () => {
    it("submits create_lock with all args and returns the id as a string", async () => {
      submitCallWithHash.mockResolvedValue({ result: 42n, txHash: "hash-1" })
      const signTx = vi.fn().mockResolvedValue({ signedTxXdr: "AAAA" })
      const onProgress = vi.fn()

      const result = await createLpLock(
        {
          poolShareAddress: VALID_TOKEN,
          dex: "soroswap",
          tokenA: TOKEN_A,
          tokenB: TOKEN_B,
          amount: 500,
          beneficiary: VALID_BENEFICIARY,
          unlockAt: 9_999_999_999,
          metadata: { description: "incentive pool" },
        },
        VALID_ADDRESS,
        signTx,
        onProgress,
      )

      expect(result).toEqual({ id: "42", txHash: "hash-1" })
      expect(submitCallWithHash.mock.calls[0][0]).toBe(LP_LOCKER_ADDR)
      expect(submitCallWithHash.mock.calls[0][1]).toBe("create_lock")
      expect(submitCallWithHash.mock.calls[0][3]).toBe(VALID_ADDRESS)
      expect(submitCallWithHash.mock.calls[0][4]).toBe(signTx)
      expect(submitCallWithHash.mock.calls[0][5]).toBe(onProgress)

      const scArgs = submitCallWithHash.mock.calls[0][2] as xdr.ScVal[]
      expect(scArgs).toHaveLength(9)
      expect(scValToNative(scArgs[0])).toBe(VALID_ADDRESS) // source/creator
      expect(scValToNative(scArgs[1])).toBe(VALID_TOKEN) // pool share
      expect(scValToNative(scArgs[4])).toBe(TOKEN_B)
      expect(scValToNative(scArgs[5])).toBe(500_0000000n) // amount in stroops
      expect(scValToNative(scArgs[7])).toBe(9_999_999_999n) // unlockAt as u64
    })

    it("encodes the dex enum variant as a vec of symbols", async () => {
      submitCallWithHash.mockResolvedValue({ result: 1n, txHash: "hash" })
      await createLpLock(
        {
          poolShareAddress: VALID_TOKEN,
          dex: "aquarius",
          tokenA: TOKEN_A,
          tokenB: TOKEN_B,
          amount: 1,
          beneficiary: VALID_BENEFICIARY,
          unlockAt: 9_999_999_999,
        },
        VALID_ADDRESS,
        vi.fn().mockResolvedValue({ signedTxXdr: "AAAA" }),
      )
      const scArgs = submitCallWithHash.mock.calls[0][2] as xdr.ScVal[]
      const dexArg = scArgs[2]
      expect(dexArg.switch().name).toBe("scvVec")
      const inner = scValToNative(dexArg) as unknown[]
      expect(inner).toEqual(["Aquarius"])
    })

    it("sends a full metadata map with empty strings when metadata is not provided", async () => {
      submitCallWithHash.mockResolvedValue({ result: 1n, txHash: "hash" })
      await createLpLock(
        {
          poolShareAddress: VALID_TOKEN,
          dex: "aquarius",
          tokenA: TOKEN_A,
          tokenB: TOKEN_B,
          amount: 1,
          beneficiary: VALID_BENEFICIARY,
          unlockAt: 9_999_999_999,
        },
        VALID_ADDRESS,
        vi.fn().mockResolvedValue({ signedTxXdr: "AAAA" }),
      )
      const scArgs = submitCallWithHash.mock.calls[0][2] as xdr.ScVal[]
      const metadataArg = scArgs[8]
      expect(metadataArg.switch().name).toBe("scvMap")
      const map = scValToNative(metadataArg) as Record<string, unknown>
      expect(map).toEqual({ description: "", logo_url: "", project_url: "" })
    })
  })

  describe("withdrawLpLock / extendLpLock / transferLpBeneficiary", () => {
    it("withdrawLpLock calls the withdraw method with just the lock id", async () => {
      submitCallWithHash.mockResolvedValue({ result: undefined, txHash: "hash-w" })
      const result = await withdrawLpLock("42", VALID_ADDRESS, vi.fn().mockResolvedValue({ signedTxXdr: "AAAA" }))
      expect(result).toEqual({ txHash: "hash-w" })
      expect(submitCallWithHash.mock.calls[0][1]).toBe("withdraw")
      expect(submitCallWithHash.mock.calls[0][2]).toHaveLength(1)
    })

    it("extendLpLock calls extend with the lock id and the new unlock timestamp", async () => {
      submitCallWithHash.mockResolvedValue({ result: undefined, txHash: "hash-e" })
      const result = await extendLpLock(
        "42",
        9_999_999_999,
        VALID_ADDRESS,
        vi.fn().mockResolvedValue({ signedTxXdr: "AAAA" }),
      )
      expect(result).toEqual({ txHash: "hash-e" })
      expect(submitCallWithHash.mock.calls[0][1]).toBe("extend")
      const scArgs = submitCallWithHash.mock.calls[0][2] as xdr.ScVal[]
      expect(scArgs).toHaveLength(2)
      expect(scValToNative(scArgs[0])).toBe(42n)
      expect(scValToNative(scArgs[1])).toBe(9_999_999_999n)
    })

    it("transferLpBeneficiary calls transfer_beneficiary with the lock id and new beneficiary", async () => {
      submitCallWithHash.mockResolvedValue({ result: undefined, txHash: "hash-t" })
      const result = await transferLpBeneficiary(
        "42",
        VALID_BENEFICIARY,
        VALID_ADDRESS,
        vi.fn().mockResolvedValue({ signedTxXdr: "AAAA" }),
      )
      expect(result).toEqual({ txHash: "hash-t" })
      expect(submitCallWithHash.mock.calls[0][1]).toBe("transfer_beneficiary")
      const scArgs = submitCallWithHash.mock.calls[0][2] as xdr.ScVal[]
      expect(scArgs).toHaveLength(2)
      expect(scValToNative(scArgs[0])).toBe(42n)
      expect(scValToNative(scArgs[1])).toBe(VALID_BENEFICIARY)
    })
  })
})
