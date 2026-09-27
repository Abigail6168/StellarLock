import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { StellarWalletsKit, WalletNetwork, allowAllModules } from "@creit.tech/stellar-wallets-kit"
import { trackEvent } from "@/lib/analytics"
import { NETWORK } from "@/lib/stellar"
import { notify } from "../lib/utils"
import { createLogger } from "@/lib/logger"
import { useSessionRecovery } from "@/hooks/useSessionRecovery"

const log = createLogger("useWallet")

const STORAGE_KEY = "stellarlock:wallet"
const WALLET_ID_KEY = "stellarlock:wallet-id"
const CONNECTION_CHECK_INTERVAL = 10_000

interface WalletContextValue {
  address: string | null
  isConnected: boolean
  connecting: boolean
  connectState: "idle" | "connecting" | "retrying" | "failed" | "success"
  connectError: string | null
  connectHelp: string | null
  disconnected: boolean
  networkChanged: boolean
  connect: () => Promise<void>
  disconnect: () => void
  dismissDisconnectAlert: () => void
  dismissNetworkAlert: () => void
  signTransaction: (xdr: string) => Promise<{ signedTxXdr: string }>
}

const WalletContext = createContext<WalletContextValue | null>(null)

const walletNetwork = NETWORK.id === "mainnet" ? WalletNetwork.PUBLIC : WalletNetwork.TESTNET

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [connectState, setConnectState] = useState<WalletContextValue["connectState"]>("idle")
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connectHelp, setConnectHelp] = useState<string | null>(null)
  const [disconnected, setDisconnected] = useState(false)
  const [networkChanged, setNetworkChanged] = useState(false)
  const connectionCheckIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const kitRef = useRef<StellarWalletsKit | null>(null)
  const connectAttemptRef = useRef(false)

  function getKit(): StellarWalletsKit {
    if (!kitRef.current) {
      const savedWalletId = localStorage.getItem(WALLET_ID_KEY) ?? ""
      kitRef.current = new StellarWalletsKit({
        network: walletNetwork,
        selectedWalletId: savedWalletId,
        modules: allowAllModules(),
      })
    }
    return kitRef.current
  }

  // Restore persisted session and verify it's still accessible
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    const savedWalletId = localStorage.getItem(WALLET_ID_KEY)
    if (!saved || !savedWalletId) return
    const k = getKit()
    k.setWallet(savedWalletId)
    k.getAddress()
      .then(({ address: publicKey }) => {
        if (publicKey && publicKey === saved) {
          setAddress(saved)
        } else {
          localStorage.removeItem(STORAGE_KEY)
          localStorage.removeItem(WALLET_ID_KEY)
        }
      })
      .catch(() => {
        localStorage.removeItem(STORAGE_KEY)
        localStorage.removeItem(WALLET_ID_KEY)
      })
  }, [])

  // Poll wallet connection status every 10 seconds
  useEffect(() => {
    if (!address) return

    const checkConnection = async () => {
      try {
        const k = getKit()
        const { address: publicKey } = await k.getAddress()
        if (!publicKey || publicKey !== address) {
          setDisconnected(true)
          setAddress(null)
          localStorage.removeItem(STORAGE_KEY)
          localStorage.removeItem(WALLET_ID_KEY)
          return
        }

        // Issue #746: networkChanged was declared, exposed on the context,
        // and reset by disconnect()/dismissNetworkAlert(), but nothing ever
        // called setNetworkChanged(true) — a user who switched the wallet's
        // network mid-session never saw the (fully built, translated) alert.
        // Piggyback on this existing poll to detect that divergence.
        const { networkPassphrase } = await k.getNetwork()
        if (networkPassphrase !== String(NETWORK.passphrase)) {
          setNetworkChanged(true)
        }
      } catch {
        setDisconnected(true)
        setAddress(null)
        localStorage.removeItem(STORAGE_KEY)
        localStorage.removeItem(WALLET_ID_KEY)
      }
    }

    connectionCheckIntervalRef.current = setInterval(() => void checkConnection(), CONNECTION_CHECK_INTERVAL)
    return () => {
      if (connectionCheckIntervalRef.current) {
        clearInterval(connectionCheckIntervalRef.current)
      }
    }
  }, [address])

  const connect = useCallback(async () => {
    if (connectAttemptRef.current) return

    connectAttemptRef.current = true
    setConnecting(true)
    setConnectState("connecting")
    setConnectError(null)
    setConnectHelp(null)

    const k = getKit()

    try {
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          await new Promise<void>((resolve, reject) => {
            void k.openModal({
              onWalletSelected: (option) => {
                void (async () => {
                  try {
                    k.setWallet(option.id)
                    const { address: publicKey } = await k.getAddress()
                    if (!publicKey) {
                      reject(new Error("Wallet returned no public key"))
                      return
                    }
                    setAddress(publicKey)
                    localStorage.setItem(STORAGE_KEY, publicKey)
                    localStorage.setItem(WALLET_ID_KEY, option.id)
                    trackEvent("wallet_connect")
                    setConnectState("success")
                    resolve()
                  } catch (err) {
                    reject(err instanceof Error ? err : new Error(String(err)))
                  }
                })()
              },
              onClosed: () => reject(new Error("Connection cancelled")),
            })
          })
          return
        } catch (err: unknown) {
          // Issue #745: the user explicitly closing the wallet-selection
          // modal (onClosed) is an intentional abort, not a failure to
          // retry — without this, the modal would silently reopen itself
          // after a backoff delay, up to 3 more times.
          if (err instanceof Error && err.message === "Connection cancelled") {
            setConnectState("idle")
            setConnectError(null)
            setConnectHelp(null)
            return
          }

          if (attempt < 4) {
            const delay = 1000 * 2 ** (attempt - 1)
            setConnectState("retrying")
            const message = err instanceof Error ? err.message : String(err)
            setConnectError(`Retrying in ${delay / 1000}s…`)
            setConnectHelp(getConnectHelp(message))
            await new Promise((resolve) => setTimeout(resolve, delay))
            continue
          }

          const msg = err instanceof Error ? err.message : String(err)
          log.error("Wallet connect error", { msg })
          setConnectState("failed")
          setConnectError(getFriendlyError(msg))
          setConnectHelp(getConnectHelp(msg))
          notify.error(getFriendlyError(msg))
        }
      }
    } finally {
      setConnecting(false)
      connectAttemptRef.current = false
    }
  }, [])

  const disconnect = useCallback(() => {
    setAddress(null)
    setDisconnected(false)
    setNetworkChanged(false)
    setConnectState("idle")
    setConnectError(null)
    setConnectHelp(null)
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(WALLET_ID_KEY)
    if (connectionCheckIntervalRef.current) {
      clearInterval(connectionCheckIntervalRef.current)
      connectionCheckIntervalRef.current = null
    }
    trackEvent("wallet_disconnect")
  }, [])

  const dismissDisconnectAlert = useCallback(() => {
    setDisconnected(false)
  }, [])

  const dismissNetworkAlert = useCallback(() => {
    setNetworkChanged(false)
  }, [])

  const signTransaction = useCallback(
    async (xdr: string): Promise<{ signedTxXdr: string }> => {
      if (!address) throw new Error("Wallet not connected")
      const k = getKit()
      const result = await k.signTransaction(xdr, {
        networkPassphrase: NETWORK.passphrase,
        address,
      })
      if (!result.signedTxXdr) throw new Error("Wallet returned empty transaction — did you approve it?")
      return { signedTxXdr: result.signedTxXdr }
    },
    [address],
  )

  const value = useMemo<WalletContextValue>(
    () => ({
      address,
      isConnected: !!address,
      connecting,
      connectState,
      connectError,
      connectHelp,
      disconnected,
      networkChanged,
      connect,
      disconnect,
      dismissDisconnectAlert,
      dismissNetworkAlert,
      signTransaction,
    }),
    [
      address,
      connecting,
      connectState,
      connectError,
      connectHelp,
      disconnected,
      networkChanged,
      connect,
      disconnect,
      dismissDisconnectAlert,
      dismissNetworkAlert,
      signTransaction,
    ],
  )

  return (
    <WalletContext.Provider value={value}>
      <SessionRecoveryBridge />
      {children}
    </WalletContext.Provider>
  )
}

/** Inner bridge: consumes WalletContext so useSessionRecovery can call useWallet(). */
function SessionRecoveryBridge() {
  useSessionRecovery()
  return null
}

function getFriendlyError(message: string): string {
  const normalized = message.toLowerCase()
  if (normalized.includes("cancel") || normalized.includes("rejected"))
    return "Connection was rejected. Please approve the prompt in Freighter."
  if (normalized.includes("network"))
    return "The wallet is on the wrong network. Switch Freighter to the app network and try again."
  if (normalized.includes("freighter") || normalized.includes("extension"))
    return "Freighter was not detected. Install or unlock the extension and retry."
  return message
}

function getConnectHelp(message: string): string {
  const normalized = message.toLowerCase()
  if (normalized.includes("cancel") || normalized.includes("rejected"))
    return "Approve the connection popup in Freighter to continue."
  if (normalized.includes("network")) return "Switch Freighter to Testnet or Mainnet to match the app and try again."
  if (normalized.includes("freighter") || normalized.includes("extension"))
    return "Install the Freighter extension or unlock it, then try again."
  return "Check your browser extension and network connection, then retry."
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider")
  return ctx
}
