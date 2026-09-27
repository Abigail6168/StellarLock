import { createContext, useContext, useState, useCallback, useRef, ReactNode } from "react"

interface AnnouncerContextValue {
  message: string
  announce: (msg: string, priority?: "polite" | "assertive") => void
}

const AnnouncerContext = createContext<AnnouncerContextValue>({
  message: "",
  announce: () => {},
})

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState("")
  const [assertive, setAssertive] = useState("")

  // One timeout ref per priority so a rapid second call always cancels the
  // first pending timeout before scheduling its own — prevents stale/out-of-order
  // announcements reaching screen readers (fixes #754).
  const politeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const assertiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const announce = useCallback((msg: string, priority: "polite" | "assertive" = "polite") => {
    // Clear then set — forces screen reader to re-announce even if same message.
    // Cancel any in-flight timeout for this priority first so only the latest
    // message wins and arrival order is preserved.
    if (priority === "assertive") {
      if (assertiveTimerRef.current !== null) {
        clearTimeout(assertiveTimerRef.current)
      }
      setAssertive("")
      assertiveTimerRef.current = setTimeout(() => {
        assertiveTimerRef.current = null
        setAssertive(msg)
      }, 50)
    } else {
      if (politeTimerRef.current !== null) {
        clearTimeout(politeTimerRef.current)
      }
      setPolite("")
      politeTimerRef.current = setTimeout(() => {
        politeTimerRef.current = null
        setPolite(msg)
      }, 50)
    }
  }, [])

  return (
    <AnnouncerContext.Provider value={{ message: polite, announce }}>
      {children}
      {/* Polite: waits for user to finish current action */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {polite}
      </div>
      {/* Assertive: interrupts — use for errors only */}
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive}
      </div>
    </AnnouncerContext.Provider>
  )
}

export function useAnnouncer() {
  return useContext(AnnouncerContext)
}
