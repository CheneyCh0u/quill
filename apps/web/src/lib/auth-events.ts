/**
 * Global signal that the server rejected a request with 401 — fired by
 * RemoteVault.onUnauthorized + the few HTTP helpers in this folder that
 * don't go through it. App.tsx subscribes here so any component issuing
 * a vault/agent/providers call automatically bounces back to /login when
 * the session expires, no manual error handling needed.
 *
 * Module-local pub/sub instead of window events keeps it framework-free
 * and trivially testable under bun:test (no DOM stub needed).
 */
type Listener = () => void
const listeners = new Set<Listener>()

export function notifyUnauthorized(): void {
  for (const fn of listeners) fn()
}

export function onUnauthorized(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
