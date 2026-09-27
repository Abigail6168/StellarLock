/**
 * Unit tests for src/hooks/useWallet.tsx — #746
 *
 * networkChanged was declared, exposed on WalletContext, and reset by
 * disconnect()/dismissNetworkAlert() — but nothing ever called
 * setNetworkChanged(true), so the fully-built "network changed, please
 * reconnect" alert could never actually appear. This covers the new
 * detection added to the existing 10s connection-status poll: comparing
 * the wallet's active network (via the kit's getNetwork()) against
 * NETWORK.passphrase.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { Networks } from "@stellar/stellar-sdk"
import type { ReactNode } from "react"

const getAddressMock = vi.fn()
const getNetworkMock = vi.fn()

vi.mock("@creit.tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: vi.fn().mockImplementation(() => ({
    getAddress: getAddressMock,
    getNetwork: getNetworkMock,
    setWallet: vi.fn(),
    openModal: vi.fn(),
    signTransaction: vi.fn(),
  })),
  WalletNetwork: { PUBLIC: "PUBLIC", TESTNET: "TESTNET" },
  allowAllModules: vi.fn(() => []),
}))

import { WalletProvider, useWallet } from "@/hooks/useWallet"

const WALLET_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
const STORAGE_KEY = "stellarlock:wallet"
const WALLET_ID_KEY = "stellarlock:wallet-id"

function wrapper({ children }: { children: ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>
}

// Flushes the microtask queue (mount-time getAddress()/getNetwork() promise
// chains) without needing a real network-changed timer to be due.
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe("useWallet — network-change detection (#746)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    getAddressMock.mockReset()
    getNetworkMock.mockReset()
    getAddressMock.mockResolvedValue({ address: WALLET_ADDRESS })
    // Test env is stubbed to VITE_NETWORK=TESTNET (src/test/setup.ts), so
    // NETWORK.passphrase is Networks.TESTNET — matches by default.
    getNetworkMock.mockResolvedValue({ network: "TESTNET", networkPassphrase: Networks.TESTNET })
    localStorage.setItem(STORAGE_KEY, WALLET_ADDRESS)
    localStorage.setItem(WALLET_ID_KEY, "freighter")
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it("sets networkChanged when the wallet's active network no longer matches NETWORK.passphrase", async () => {
    const { result } = renderHook(() => useWallet(), { wrapper })

    await flush()
    expect(result.current.address).toBe(WALLET_ADDRESS)
    expect(result.current.networkChanged).toBe(false)

    // Simulate switching Freighter to a different network mid-session.
    getNetworkMock.mockResolvedValue({ network: "PUBLIC", networkPassphrase: Networks.PUBLIC })

    // Advance past the 10s connection-status poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(result.current.networkChanged).toBe(true)
  })

  it("does not set networkChanged when the wallet's network still matches", async () => {
    const { result } = renderHook(() => useWallet(), { wrapper })

    await flush()
    expect(result.current.address).toBe(WALLET_ADDRESS)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(result.current.networkChanged).toBe(false)
  })

  it("dismissNetworkAlert() clears networkChanged", async () => {
    const { result } = renderHook(() => useWallet(), { wrapper })
    await flush()

    getNetworkMock.mockResolvedValue({ network: "PUBLIC", networkPassphrase: Networks.PUBLIC })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.networkChanged).toBe(true)

    act(() => {
      result.current.dismissNetworkAlert()
    })

    expect(result.current.networkChanged).toBe(false)
  })
})
