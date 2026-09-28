import "@/lib/env" // fail-fast env var validation
import "@/i18n" // initialise i18next before any component calls useTranslation
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { HelmetProvider } from "react-helmet-async"
import { App } from "@/App"
import { WalletProvider } from "@/hooks/useWallet"
import { ContractEventProvider } from "@/hooks/useContractEventContext"
import { AnnouncerProvider } from "@/hooks/useAnnouncer"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { initErrorTracking } from "@/lib/sentry"
import { initWebVitals } from "@/lib/web-vitals"
import { rearmAllReminders } from "@/hooks/useNotifications"
import "@/index.css"

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW registration is best-effort; app works without it
    })
  })
}
initErrorTracking()
void initWebVitals()

// Re-arm browser unlock-reminder timers for every lock that had notifications
// enabled in a previous session. Pure in-memory setTimeouts are lost on tab
// close/refresh, so we rebuild them on every bootstrap (issue #752).
rearmAllReminders()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <HelmetProvider>
        <BrowserRouter>
          <AnnouncerProvider>
            <WalletProvider>
              <ContractEventProvider>
                <App />
              </ContractEventProvider>
            </WalletProvider>
          </AnnouncerProvider>
        </BrowserRouter>
      </HelmetProvider>
    </ErrorBoundary>
  </StrictMode>,
)
