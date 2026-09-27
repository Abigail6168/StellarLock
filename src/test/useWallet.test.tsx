/**
 * Unit tests for src/hooks/useWallet.tsx — #745
 *
 * connect()'s retry loop used to treat every openModal rejection the same
 * way, including the user deliberately closing the wallet-selection modal
 * (onClosed). That meant closing the modal caused it to silently reopen
 * itself after a 1s/2s/4s backoff, up to 3 more times. This covers the
 * fix: the "Connection cancelled" rejection now exits the retry loop
 * immediately instead of being retried.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { ReactNode } from "react"

const openModalMock = vi.fn()
const getAddressMock = vi.fn()

vi.mock("@creit.tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: vi.fn().mockImplementation(() => ({
    getAddress: getAddressMock,
    getNetwork: vi
      .fn()
      .mockResolvedValue({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
    setWallet: vi.fn(),
    openModal: openModalMock,
    signTransaction: vi.fn(),
  })),
  WalletNetwork: { PUBLIC: "PUBLIC", TESTNET: "TESTNET" },
  allowAllModules: vi.fn(() => []),
}))

import { WalletProvider, useWallet } from "@/hooks/useWallet"

function wrapper({ children }: { children: ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>
}

describe("useWallet — connect() cancellation (#745)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    openModalMock.mockReset()
    getAddressMock.mockReset()
    getAddressMock.mockResolvedValue({ address: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it("does not retry when the user closes the wallet-selection modal", async () => {
    openModalMock.mockImplementation(({ onClosed }: { onClosed: () => void }) => {
      onClosed()
    })

    const { result } = renderHook(() => useWallet(), { wrapper })

    await act(async () => {
      await result.current.connect()
    })

    expect(openModalMock).toHaveBeenCalledTimes(1)
    expect(result.current.connectState).toBe("idle")
    expect(result.current.connectError).toBeNull()

    // Advance well past every backoff delay (1s/2s/4s) — if the old bug
    // were still present, this would trigger further openModal calls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(openModalMock).toHaveBeenCalledTimes(1)
    expect(result.current.connecting).toBe(false)
  })

  it("still retries on a genuine failure (not a user-initiated cancel)", async () => {
    const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
    openModalMock.mockImplementation(({ onWalletSelected }: { onWalletSelected: (o: { id: string }) => void }) => {
      // Simulate a transient failure distinct from "Connection cancelled".
      onWalletSelected({ id: "freighter" })
    })
    // Attempt 1 fails with a genuine error; attempt 2 (the retry) succeeds.
    getAddressMock.mockRejectedValueOnce(new Error("network error"))
    getAddressMock.mockResolvedValueOnce({ address: ADDRESS })

    const { result } = renderHook(() => useWallet(), { wrapper })

    let connectPromise!: Promise<void>
    act(() => {
      connectPromise = result.current.connect()
    })

    // Let the first attempt's failure and the 1s backoff elapse, so the
    // retry fires (and this time succeeds).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    await act(async () => {
      await connectPromise
    })

    expect(openModalMock).toHaveBeenCalledTimes(2)
    expect(result.current.connectState).toBe("success")
  })
})
