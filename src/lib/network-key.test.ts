import { describe, it, expect, vi } from "vitest"
import { resolveNetworkKey } from "./network-key"

describe("resolveNetworkKey (#742)", () => {
  it('resolves "testnet" to "testnet"', () => {
    vi.stubEnv("VITE_NETWORK", "testnet")
    expect(resolveNetworkKey()).toBe("testnet")
  })

  it('resolves "mainnet" to "mainnet"', () => {
    vi.stubEnv("VITE_NETWORK", "mainnet")
    expect(resolveNetworkKey()).toBe("mainnet")
  })

  it('resolves "staging" to "mainnet" (staging deploys against mainnet contracts)', () => {
    vi.stubEnv("VITE_NETWORK", "staging")
    expect(resolveNetworkKey()).toBe("mainnet")
  })

  it('resolves "public" to "mainnet" (backward-compat synonym)', () => {
    vi.stubEnv("VITE_NETWORK", "public")
    expect(resolveNetworkKey()).toBe("mainnet")
  })

  it("is case-insensitive", () => {
    vi.stubEnv("VITE_NETWORK", "STAGING")
    expect(resolveNetworkKey()).toBe("mainnet")
  })

  it('defaults to "testnet" for an unrecognized value', () => {
    vi.stubEnv("VITE_NETWORK", "something-else")
    expect(resolveNetworkKey()).toBe("testnet")
  })
})
