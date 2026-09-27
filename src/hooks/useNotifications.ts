import { useCallback, useState, useSyncExternalStore } from "react"

const STORAGE_KEY_PREFS = "stellarlock:notification_prefs"
const STORAGE_KEY_HISTORY = "stellarlock:notification_history"
const MAX_NOTIFICATIONS = 20
const NOTIFICATION_TTL = 30 * 24 * 60 * 60 * 1000 // 30 days

export type NotificationType =
  | "lock_created"
  | "lock_unlocked"
  | "lock_withdrawn"
  | "lock_extended"
  | "unlock_reminder"
  | "beneficiary_transfer"
  | "unlock_approaching"

export interface Notification {
  id: string
  type: NotificationType
  lockId: string
  lockKind?: "token" | "lp"
  title: string
  message: string
  timestamp: number
  read: boolean
  data?: Record<string, unknown>
}

export interface NotificationPrefs {
  lockId?: string
  browser: boolean
  /** Unix-ms timestamp of the lock's unlock time — persisted so reminders can
   *  be re-armed after a page reload without requiring the lock data to be
   *  fetched first (issue #752). */
  unlockAt?: number
  email?: string
  webhookUrl?: string
  types: Partial<Record<NotificationType, boolean>>
}

// ---------------------------------------------------------------------------
// Subscription API helpers
// ---------------------------------------------------------------------------

const API_BASE = import.meta.env.VITE_API_BASE ?? ""

export interface SubscribeParams {
  lockId: string
  address: string
  email?: string
  webhookUrl?: string
}

/**
 * Register (or update) an email / webhook subscription for a lock.
 * Returns the subscription id on success, throws on network or validation error.
 */
export async function subscribeNotifications(params: SubscribeParams): Promise<string> {
  const res = await fetch(`${API_BASE}/api/notifications/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lockId: params.lockId,
      address: params.address,
      email: params.email ?? null,
      webhookUrl: params.webhookUrl ?? null,
    }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Subscribe failed (${res.status})`)
  }
  const data = (await res.json()) as { id: string }
  return data.id
}

/**
 * Remove an email / webhook subscription for a lock.
 */
export async function unsubscribeNotifications(lockId: string, address: string): Promise<void> {
  const params = new URLSearchParams({ lockId, address })
  const res = await fetch(`${API_BASE}/api/notifications/subscribe?${params.toString()}`, {
    method: "DELETE",
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`Unsubscribe failed (${res.status})`)
  }
}

function loadPrefs(): Record<string, NotificationPrefs> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_PREFS) ?? "{}") as Record<string, NotificationPrefs>
  } catch {
    return {}
  }
}

function savePrefs(prefs: Record<string, NotificationPrefs>) {
  localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(prefs))
}

function loadNotifications(): Notification[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY) ?? "[]") as Notification[]
  } catch {
    return []
  }
}

function saveNotifications(notifications: Notification[]) {
  localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(notifications))
}

export function useNotificationPrefs(lockId?: string) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => {
    if (!lockId) return { browser: false, types: getDefaultPrefs() }
    const all = loadPrefs()
    return all[lockId] ?? { lockId, browser: false, types: getDefaultPrefs() }
  })

  const update = useCallback(
    (patch: Partial<NotificationPrefs>) => {
      setPrefs((prev) => {
        const next = { ...prev, ...patch }
        // Always merge into the full prefs map — keyed either by lockId or
        // the "global" key — so writing one entry never clobbers the others.
        const all = loadPrefs()
        all[lockId ?? "global"] = next
        savePrefs(all)
        return next
      })
    },
    [lockId],
  )

  return { prefs, update }
}

/**
 * Read the global notification preferences (set from the Settings page)
 * synchronously from storage. Used by notification-sending logic that runs
 * outside of a React component (e.g. `scheduleUnlockReminder`) to decide
 * whether/how a notification should actually be delivered.
 */
function getGlobalPrefs(): NotificationPrefs {
  return loadPrefs().global ?? { browser: false, types: getDefaultPrefs() }
}

function getDefaultPrefs(): Partial<Record<NotificationType, boolean>> {
  return {
    lock_created: true,
    lock_unlocked: true,
    lock_withdrawn: true,
    lock_extended: true,
    unlock_reminder: true,
    beneficiary_transfer: true,
    unlock_approaching: true,
  }
}

export function useBrowserNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  )

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return "denied" as const
    const result = await Notification.requestPermission()
    setPermission(result)
    return result
  }, [])

  return { permission, requestPermission }
}

export function scheduleUnlockReminder(lockId: string, unlockAt: number) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return

  // Respect the global notification preferences configured on the Settings
  // page: a disabled master "browser" switch silences all reminders, and
  // each reminder category can be individually opted out of via `types`.
  const globalPrefs = getGlobalPrefs()
  if (globalPrefs.browser === false) return
  const types = globalPrefs.types ?? getDefaultPrefs()

  // Persist the unlockAt timestamp into the per-lock prefs entry so that
  // rearmAllReminders() can reconstruct timers after a page reload without
  // needing to fetch the lock from the chain (issue #752).
  const all = loadPrefs()
  const existing = all[lockId] ?? { lockId, browser: true, types: getDefaultPrefs() }
  all[lockId] = { ...existing, browser: true, unlockAt }
  savePrefs(all)

  const now = Date.now()
  const oneDay = 24 * 60 * 60 * 1000
  const sevenDays = 7 * oneDay

  const reminders: { delay: number; label: string; type: NotificationType }[] = [
    { delay: unlockAt - sevenDays - now, label: "7 days", type: "unlock_reminder" },
    { delay: unlockAt - oneDay - now, label: "1 day", type: "unlock_reminder" },
    { delay: unlockAt - now, label: "now", type: "unlock_approaching" },
  ]

  for (const { delay, label, type } of reminders) {
    if (types[type] === false) continue
    if (delay > 0 && delay < 2_147_483_647) {
      setTimeout(() => {
        new Notification("StellarLock", {
          body:
            label === "now"
              ? `Lock #${lockId} has unlocked! You can now withdraw your tokens.`
              : `Lock #${lockId} unlocks in ${label}.`,
          icon: "/favicon.svg",
        })
      }, delay)
    }
  }
}

/**
 * Re-arm unlock reminder timers for every lock that has browser notifications
 * enabled in stored prefs. Call once on app bootstrap so reminders survive
 * tab closes and page reloads (issue #752).
 *
 * Only locks whose stored `unlockAt` is still in the future are re-armed;
 * already-elapsed entries are silently skipped.
 */
export function rearmAllReminders(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return

  const all = loadPrefs()
  for (const [key, prefs] of Object.entries(all)) {
    // Skip the global settings entry and any lock entries without browser
    // notifications enabled or without a persisted unlock timestamp.
    if (key === "global") continue
    if (!prefs.browser) continue
    if (typeof prefs.unlockAt !== "number") continue
    if (prefs.unlockAt <= Date.now()) continue

    scheduleUnlockReminder(key, prefs.unlockAt)
  }
}

export interface WebhookPayload {
  event: "unlock_reminder" | "unlocked"
  lockId: string
  unlockAt: number
  reminderDays?: number
}

export async function sendWebhook(url: string, payload: WebhookPayload): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Notification center store
//
// The navbar bell and the code that records activity (a lock being created,
// withdrawn, extended or transferred) sit in different parts of the tree, so
// the history cannot live in per-hook state — every `useNotificationCenter()`
// subscribes to this single module-level store instead. `addNotification` is a
// plain function so code outside a component can record an entry too.
// ---------------------------------------------------------------------------

type StoreListener = () => void

const listeners = new Set<StoreListener>()
let notificationStore: Notification[] = cleanOldNotifications(loadNotifications())

function setNotificationStore(next: Notification[]) {
  notificationStore = next
  saveNotifications(next)
  listeners.forEach((listener) => listener())
}

function subscribeToStore(listener: StoreListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getStoreSnapshot(): Notification[] {
  return notificationStore
}

/**
 * Record an in-app notification and surface it on the navbar bell.
 * Categories the user switched off in the global notification preferences are
 * dropped; the created entry is returned, or `null` when it was suppressed.
 */
export function addNotification(notif: Omit<Notification, "id" | "timestamp" | "read">): Notification | null {
  const types = getGlobalPrefs().types ?? getDefaultPrefs()
  if (types[notif.type] === false) return null

  const created: Notification = {
    ...notif,
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    read: false,
  }
  setNotificationStore([created, ...notificationStore].slice(0, MAX_NOTIFICATIONS))
  return created
}

export function markNotificationAsRead(id: string) {
  setNotificationStore(notificationStore.map((n) => (n.id === id ? { ...n, read: true } : n)))
}

export function markAllNotificationsAsRead() {
  setNotificationStore(notificationStore.map((n) => ({ ...n, read: true })))
}

export function clearNotificationHistory() {
  setNotificationStore([])
}

/**
 * Re-read the history from storage, discarding whatever the store holds.
 * Exists so tests that clear localStorage can start from a clean store.
 */
export function resetNotificationStore() {
  notificationStore = cleanOldNotifications(loadNotifications())
  listeners.forEach((listener) => listener())
}

export function useNotificationCenter() {
  const notifications = useSyncExternalStore(subscribeToStore, getStoreSnapshot)
  const unreadCount = notifications.filter((n) => !n.read).length

  return {
    notifications,
    addNotification,
    markAsRead: markNotificationAsRead,
    markAllAsRead: markAllNotificationsAsRead,
    clearHistory: clearNotificationHistory,
    unreadCount,
  }
}

function cleanOldNotifications(notifications: Notification[]): Notification[] {
  const now = Date.now()
  return notifications.filter((n) => now - n.timestamp < NOTIFICATION_TTL)
}
