import { useEffect, useState } from "react"

export type RpcStatus = "connected" | "slow" | "disconnected"

export interface RpcHealthState {
  status: RpcStatus
  lastChecked: Date | null
}

const RPC_ENDPOINTS = ["https://soroban-testnet.stellar.org", "https://horizon-testnet.stellar.org"]

const HEALTH_CHECK_INTERVAL = 30000 // 30 seconds
const RPC_TIMEOUT = 3000 // hard timeout — treat as disconnected if exceeded
const SLOW_THRESHOLD = 1500 // flag as slow if response takes longer than this

async function checkRpcHealth(): Promise<RpcStatus> {
  try {
    for (const endpoint of RPC_ENDPOINTS) {
      // Share one AbortController between the fetch and the timeout so that
      // whichever branch fires second is guaranteed to be a no-op.  Without
      // this the losing branch keeps running as an abandoned in-flight request
      // for the lifetime of the page (issue #753).
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT)

      const start = Date.now()
      let response: Response
      try {
        response = await fetch(`${endpoint}/health`, {
          method: "HEAD",
          signal: controller.signal,
        })
      } finally {
        // Always clear the timeout whether the fetch succeeded, failed, or was
        // aborted — prevents the timer from firing against a future request.
        clearTimeout(timeoutId)
      }

      // If the abort signal already fired by the time we get here it means the
      // fetch resolved *after* the timeout (e.g. a mock that ignores signals).
      // Treat that the same as a genuine AbortError: the endpoint is too slow.
      if (controller.signal.aborted) {
        return "disconnected"
      }

      // If we reach here the request completed before RPC_TIMEOUT,
      // so elapsed is always < RPC_TIMEOUT. Check against SLOW_THRESHOLD instead.
      const elapsed = Date.now() - start

      if (!response.ok) {
        return "disconnected"
      }

      if (elapsed > SLOW_THRESHOLD) {
        return "slow"
      }
    }

    return "connected"
  } catch {
    // Covers both network errors and AbortError from the timeout path.
    return "disconnected"
  }
}

export function useRpcHealth() {
  const [state, setState] = useState<RpcHealthState>({
    status: "connected",
    lastChecked: null,
  })

  useEffect(() => {
    let isMounted = true

    const check = async () => {
      const status = await checkRpcHealth()
      if (isMounted) {
        setState({ status, lastChecked: new Date() })
      }
    }

    // Check immediately on mount
    void check()

    // Then check every 30 seconds
    const intervalId = setInterval(() => void check(), HEALTH_CHECK_INTERVAL)

    return () => {
      isMounted = false
      clearInterval(intervalId)
    }
  }, [])

  return state
}
