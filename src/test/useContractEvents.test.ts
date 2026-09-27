import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useContractEvents } from "@/hooks/useContractEvents"

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response)
}

interface JsonRpcRequestBody {
  method?: string
  params?: { startLedger?: number; filters?: { contractIds?: string[] }[] }
}

function parseRequestBody(init?: RequestInit): JsonRpcRequestBody {
  try {
    return JSON.parse((init?.body as string) ?? "{}") as JsonRpcRequestBody
  } catch {
    return {}
  }
}

/** RPC method name from a fetch call's JSON-RPC request body. */
function rpcMethodOf(init?: RequestInit): string | undefined {
  return parseRequestBody(init).method
}

describe("useContractEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("starts with an empty events list", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    )

    const { result } = renderHook(() => useContractEvents({ contractAddress: "CCONTRACT" }))

    expect(result.current.events).toEqual([])
  })

  it("filters on both the token-locker and lp-locker contracts by default (#743)", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (rpcMethodOf(init) === "getLatestLedger") {
        return jsonResponse({ result: { sequence: 1 } })
      }
      return jsonResponse({ result: { events: [] } })
    })
    vi.stubGlobal("fetch", fetchMock)

    // No contractAddress override — should default to both known contracts,
    // not just the token-locker (whose env var being always-present made
    // the lp-locker fallback unreachable dead code before this fix).
    renderHook(() => useContractEvents({}))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const getEventsCall = fetchMock.mock.calls.find(([, init]) => rpcMethodOf(init) === "getEvents")
    const body = parseRequestBody(getEventsCall?.[1])
    expect(body.params?.filters?.[0]?.contractIds).toEqual([
      import.meta.env.VITE_TOKEN_LOCKER_CONTRACT,
      import.meta.env.VITE_LP_LOCKER_CONTRACT,
    ])
  })

  it("filters on only the override contract when contractAddress is given", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (rpcMethodOf(init) === "getLatestLedger") {
        return jsonResponse({ result: { sequence: 1 } })
      }
      return jsonResponse({ result: { events: [] } })
    })
    vi.stubGlobal("fetch", fetchMock)

    renderHook(() => useContractEvents({ contractAddress: "CCONTRACT" }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const getEventsCall = fetchMock.mock.calls.find(([, init]) => rpcMethodOf(init) === "getEvents")
    const body = parseRequestBody(getEventsCall?.[1])
    expect(body.params?.filters?.[0]?.contractIds).toEqual(["CCONTRACT"])
  })

  it("initializes the ledger cursor from getLatestLedger instead of 0 (#744)", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (rpcMethodOf(init) === "getLatestLedger") {
        return jsonResponse({ result: { sequence: 500_000 } })
      }
      return jsonResponse({ result: { events: [] } })
    })
    vi.stubGlobal("fetch", fetchMock)

    renderHook(() => useContractEvents({ contractAddress: "CCONTRACT" }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const getEventsCall = fetchMock.mock.calls.find(([, init]) => rpcMethodOf(init) === "getEvents")
    const body = parseRequestBody(getEventsCall?.[1])
    // startLedger = max(1, cursor - 1000); with cursor seeded to 500_000
    // (not the old default of 0), this must be nowhere near ledger 1.
    expect(body.params?.startLedger).toBe(499_000)
  })

  it("advances the ledger cursor on every poll even when no event matches (#744)", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (rpcMethodOf(init) === "getLatestLedger") {
        return jsonResponse({ result: { sequence: 500_000 } })
      }
      // No matching events on any poll — the cursor must still advance via
      // latestLedger, not stay frozen forever.
      return jsonResponse({ result: { events: [], latestLedger: 500_010 } })
    })
    vi.stubGlobal("fetch", fetchMock)

    renderHook(() => useContractEvents({ contractAddress: "CCONTRACT", pollInterval: 1000 }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    const getEventsCalls = fetchMock.mock.calls.filter(([, init]) => rpcMethodOf(init) === "getEvents")
    expect(getEventsCalls.length).toBeGreaterThanOrEqual(2)
    const secondBody = parseRequestBody(getEventsCalls[1][1])
    // After the first poll advanced the cursor to 500_010 (via latestLedger),
    // the second poll's startLedger must reflect that, not still be based
    // on the initial 500_000.
    expect(secondBody.params?.startLedger).toBe(499_010)
  })

  it("parses a matching lock_created event from the getEvents response", async () => {
    const fetchMock = vi.fn(() =>
      jsonResponse({
        result: {
          events: [
            {
              id: "1",
              ledger: 100,
              ledgerClosedAt: "2026-01-01T00:00:00Z",
              topic: ["lock_created", "lock-abc"],
            },
          ],
        },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const onEvent = vi.fn()
    const { result } = renderHook(() => useContractEvents({ contractAddress: "CCONTRACT", onEvent }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.events).toHaveLength(1)
    expect(result.current.events[0]).toMatchObject({
      type: "lock_created",
      lockId: "lock-abc",
      timestamp: new Date("2026-01-01T00:00:00Z").getTime(),
    })
    expect(onEvent).toHaveBeenCalledWith(result.current.events[0])
  })

  it("ignores events whose topic does not match a known event type", async () => {
    const fetchMock = vi.fn(() =>
      jsonResponse({
        result: {
          events: [{ id: "1", ledger: 1, topic: ["some_unrelated_topic", "x"] }],
        },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { result } = renderHook(() => useContractEvents({ contractAddress: "CCONTRACT" }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.events).toEqual([])
  })

  it("ignores events with no topic array", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ result: { events: [{ id: "1", ledger: 1 }] } }))
    vi.stubGlobal("fetch", fetchMock)

    const { result } = renderHook(() => useContractEvents({ contractAddress: "CCONTRACT" }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.events).toEqual([])
  })

  it("extracts the real lock id from topic[1] for lp-locker withdraw/extend/transfer events", async () => {
    const fetchMock = vi.fn(() =>
      jsonResponse({
        result: {
          events: [
            { id: "101", ledger: 1, topic: ["lp_lock_withdrawn", "5001"] },
            { id: "102", ledger: 2, topic: ["lp_lock_extended", "5002"] },
            { id: "103", ledger: 3, topic: ["lp_beneficiary_transferred", "5003"] },
          ],
        },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { result } = renderHook(() => useContractEvents({ contractAddress: "CCONTRACT" }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const lockIds = result.current.events.map((e) => e.lockId)
    expect(lockIds).toEqual(["5003", "5002", "5001"])
  })

  it("prepends new events so the most recent event is first", async () => {
    let pollCall = 0
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (rpcMethodOf(init) === "getLatestLedger") {
        return jsonResponse({ result: { sequence: 1 } })
      }
      pollCall += 1
      const topic = pollCall === 1 ? ["lock_created", "first"] : ["lock_withdrawn", "second"]
      return jsonResponse({ result: { events: [{ id: String(pollCall), ledger: pollCall, topic }] } })
    })
    vi.stubGlobal("fetch", fetchMock)

    const { result } = renderHook(() => useContractEvents({ contractAddress: "CCONTRACT", pollInterval: 1000 }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.events[0].lockId).toBe("first")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(result.current.events[0].lockId).toBe("second")
    expect(result.current.events).toHaveLength(2)
  })

  it("emits an event only once even when repeated polls return it again", async () => {
    const fetchMock = vi.fn(() =>
      jsonResponse({
        result: {
          events: [
            {
              id: "1",
              ledger: 100,
              ledgerClosedAt: "2026-01-01T00:00:00Z",
              topic: ["lock_created", "lock-abc"],
            },
          ],
        },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useContractEvents({ contractAddress: "CCONTRACT", onEvent, pollInterval: 1000 }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(onEvent).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(result.current.events).toHaveLength(1)
  })

  it("still emits new distinct events within the next poll", async () => {
    let pollCall = 0
    const firstEvent = { id: "1", ledger: 1, topic: ["lock_created", "first"] }
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (rpcMethodOf(init) === "getLatestLedger") {
        return jsonResponse({ result: { sequence: 1 } })
      }
      pollCall += 1
      const events =
        pollCall === 1 ? [firstEvent] : [firstEvent, { id: "2", ledger: 2, topic: ["lock_withdrawn", "second"] }]
      return jsonResponse({ result: { events } })
    })
    vi.stubGlobal("fetch", fetchMock)

    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useContractEvents({ contractAddress: "CCONTRACT", onEvent, pollInterval: 1000 }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(onEvent).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(onEvent).toHaveBeenCalledTimes(2)
    expect(result.current.events[0]).toMatchObject({ type: "lock_withdrawn", lockId: "second" })
    expect(result.current.events).toHaveLength(2)
  })

  it("does not throw and leaves events empty when the response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({}, false, 500)),
    )

    const { result } = renderHook(() => useContractEvents({ contractAddress: "CCONTRACT" }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.events).toEqual([])
  })

  it("does not throw and leaves events empty when the RPC returns a JSON-RPC error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ error: { message: "boom" } })),
    )

    const { result } = renderHook(() => useContractEvents({ contractAddress: "CCONTRACT" }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.events).toEqual([])
  })

  it("does not throw when fetch rejects with a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    )

    const { result } = renderHook(() => useContractEvents({ contractAddress: "CCONTRACT" }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.events).toEqual([])
  })

  it("stops polling after unmount", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ result: { events: [] } }))
    vi.stubGlobal("fetch", fetchMock)

    const { unmount } = renderHook(() => useContractEvents({ contractAddress: "CCONTRACT", pollInterval: 1000 }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const callsBeforeUnmount = fetchMock.mock.calls.length

    unmount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(fetchMock.mock.calls.length).toBe(callsBeforeUnmount)
  })
})
