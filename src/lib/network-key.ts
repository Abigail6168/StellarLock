/**
 * Resolve which network key ("testnet" or "mainnet") the app is running
 * against, from VITE_NETWORK ("testnet", "staging", or "mainnet" — see
 * .env.example).
 *
 * Issue #742: stellar.ts and useVerifiedToken each re-implemented this
 * mapping independently and disagreed on "staging" — stellar.ts treated it
 * as testnet, while useVerifiedToken treated it as mainnet (staging deploys
 * against real mainnet contracts, per .env.staging's own
 * VITE_RPC_URL/VITE_CONTRACT_ENV values). Both now derive from this one
 * shared helper instead of each guessing independently.
 *
 * "public" is accepted as a synonym for "mainnet" for backward compatibility
 * with stellar.ts's prior check, even though it isn't a documented
 * VITE_NETWORK value.
 */
export function resolveNetworkKey(): "testnet" | "mainnet" {
  const network = import.meta.env.VITE_NETWORK?.toLowerCase() ?? "testnet"
  return network === "mainnet" || network === "public" || network === "staging" ? "mainnet" : "testnet"
}
