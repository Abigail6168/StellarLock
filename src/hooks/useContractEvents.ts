import { useEffect, useRef, useCallback, useState } from "react"
import { NETWORK } from "@/lib/stellar"
import { createLogger } from "@/lib/logger"

const log = createLogger("useContractEvents")

export interface ContractEvent {
  type:
    | "lock_created"
    | "lock_withdrawn"
    | "lock_extended"
    | "beneficiary_transferred"
    | "lp_lock_created"
    | "lp_lock_withdrawn"
    | "lp_lock_extended"
    | "lp_beneficiary_transferred"
  lockId: string
  timestamp: number
  data: Record<string, unknown>
}

interface EventPollingOptions {
  contractAddress?: string
  onEvent?: (event: ContractEvent) => void
  pollInterval?: number
}

interface RawSorobanEvent {
  id?: string
  ledger?: number
  ledgerClosedAt?: string
  topic?: string[]
}

interface GetEventsResponse {
  error?: { message?: string }
  result?: { events?: RawSorobanEvent[]; latestLedger?: number }
}

interface GetLatestLedgerResponse {
  error?: { message?: string }
  result?: { sequence?: number }
}

const EVENT_POLL_INTERVAL = 3000

export function useContractEvents(options: EventPollingOptions = {}) {
  const { contractAddress, onEvent, pollInterval = EVENT_POLL_INTERVAL } = options
  const [events, setEvents] = useState<ContractEvent[]>([])
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const lastSequenceRef = useRef<number>(0)
  const emittedEventIdsRef = useRef<Set<string>>(new Set())

  const fetchEvents = useCallback(async () => {
    try {
      const rpc = import.meta.env.VITE_RPC_URL || NETWORK.rpcUrl

      const response = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getEvents",
          params: {
            startLedger: Math.max(1, lastSequenceRef.current - 1000),
            filters: [
              {
                type: "contract",
                // Issue #743: an explicit contractAddress override still
                // filters to just that one contract; the default (no
                // override) case must include both known contracts, not
                // fall through to only the first one that's set — the
                // token-locker env var is always present, so the lp-locker
                // fallback was unreachable dead code.
                contractIds: contractAddress
                  ? [contractAddress]
                  : [import.meta.env.VITE_TOKEN_LOCKER_CONTRACT, import.meta.env.VITE_LP_LOCKER_CONTRACT].filter(
                      (id): id is string => Boolean(id),
                    ),
              },
            ],
          },
        }),
      })

      if (!response.ok) {
        log.error("[getEvents error]", { status: response.status })
        return
      }

      const data = (await response.json()) as GetEventsResponse
      if (data.error) {
        log.error("[getEvents error]", { error: data.error })
        return
      }

      const responseEvents = data.result?.events ?? []
      for (const event of responseEvents) {
        if (!event.topic || event.topic.length < 1) continue

        const eventType = event.topic[0]
        if (
          !eventType?.includes("lock_created") &&
          !eventType?.includes("lock_withdrawn") &&
          !eventType?.includes("lock_extended") &&
          !eventType?.includes("beneficiary_transferred")
        ) {
          continue
        }

        const eventId = event.id ?? `${event.ledger ?? 0}:${eventType}:${event.topic[1] ?? ""}`
        if (emittedEventIdsRef.current.has(eventId)) continue
        emittedEventIdsRef.current.add(eventId)

        const contractEvent: ContractEvent = {
          type: eventType as ContractEvent["type"],
          lockId: event.topic[1] || String(event.id),
          timestamp: event.ledgerClosedAt ? new Date(event.ledgerClosedAt).getTime() : Date.now(),
          data: {
            raw: event,
          },
        }

        setEvents((prev) => [contractEvent, ...prev.slice(0, 99)])
        if (onEvent) {
          onEvent(contractEvent)
        }
      }

      // Issue #744: advance the cursor every poll, regardless of whether any
      // event matched — advancing only inside the loop above meant a poll
      // with zero matching events (the common case) never moved the cursor
      // forward, so every subsequent poll kept re-requesting from the same
      // (eventually ledger-1) startLedger forever.
      if (typeof data.result?.latestLedger === "number") {
        lastSequenceRef.current = Math.max(lastSequenceRef.current, data.result.latestLedger)
      }
    } catch (err) {
      log.error("[contract events polling error]", err)
    }
  }, [onEvent, contractAddress])

  // Issue #744: seed the cursor from the RPC's current ledger instead of
  // leaving it at 0 — otherwise the very first poll computes
  // startLedger = max(1, 0 - 1000) = 1, almost certainly outside the RPC's
  // retention window, so the live event feed never works from a fresh mount.
  const initLastSequence = useCallback(async () => {
    try {
      const rpc = import.meta.env.VITE_RPC_URL || NETWORK.rpcUrl
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger", params: {} }),
      })
      if (!response.ok) return
      const data = (await response.json()) as GetLatestLedgerResponse
      if (data.error) {
        log.error("[getLatestLedger error]", { error: data.error })
        return
      }
      if (typeof data.result?.sequence === "number") {
        lastSequenceRef.current = data.result.sequence
      }
    } catch (err) {
      log.error("[getLatestLedger error]", err)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      await initLastSequence()
      if (cancelled) return
      void fetchEvents()
      pollIntervalRef.current = setInterval(() => void fetchEvents(), pollInterval)
    })()

    return () => {
      cancelled = true
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [fetchEvents, initLastSequence, pollInterval])

  return { events }
}
