/**
 * Last-session persistence: remembers the vault folder / file that was
 * open when the app quit, so the next launch can restore it instead of
 * landing on the welcome page. Remote workspaces are intentionally not
 * recorded — they need auth and have their own reconnect flow.
 */

const KEY = 'quill:last-session'

export type LastSession = { type: 'folder' | 'file'; path: string }

export function parseLastSession(raw: string | null): LastSession | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LastSession> | null
    if (
      parsed &&
      (parsed.type === 'folder' || parsed.type === 'file') &&
      typeof parsed.path === 'string' &&
      parsed.path.length > 0
    ) {
      return { type: parsed.type, path: parsed.path }
    }
    return null
  } catch {
    return null
  }
}

export function getLastSession(): LastSession | null {
  return parseLastSession(localStorage.getItem(KEY))
}

export function saveLastSession(session: LastSession): void {
  localStorage.setItem(KEY, JSON.stringify(session))
}

export function clearLastSession(): void {
  localStorage.removeItem(KEY)
}
