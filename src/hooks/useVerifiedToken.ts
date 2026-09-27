import { useEffect, useState } from "react"
import { resolveNetworkKey } from "@/lib/network-key"

interface VerifiedEntry {
  address: string
  symbol: string
  name: string
}

interface VerifiedTokensFile {
  testnet: VerifiedEntry[]
  mainnet: VerifiedEntry[]
}

// Per-network caches so switching network env never serves the wrong list.
const _caches = new Map<string, Set<string>>()

async function loadVerifiedTokens(): Promise<Set<string>> {
  const key = resolveNetworkKey()
  const cached = _caches.get(key)
  if (cached) return cached

  try {
    const res = await fetch("/verified-tokens.json")
    if (!res.ok) return new Set()
    const data = (await res.json()) as VerifiedTokensFile

    // Build a set for the current network. Fall back gracefully if the key
    // is somehow absent (e.g. an older deployed version of the JSON file).
    const entries: VerifiedEntry[] = data[key] ?? []
    const set = new Set(entries.map((t) => t.address.toLowerCase()))
    _caches.set(key, set)
    return set
  } catch {
    return new Set()
  }
}

export function useVerifiedToken(contractId?: string): boolean | null {
  const [verified, setVerified] = useState<boolean | null>(null)

  useEffect(() => {
    if (!contractId) {
      setVerified(null)
      return
    }
    void loadVerifiedTokens().then((set) => setVerified(set.has(contractId.toLowerCase())))
  }, [contractId])

  return verified
}
