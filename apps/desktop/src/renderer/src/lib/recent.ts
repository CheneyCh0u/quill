import type { RecentEntry } from '../types'

const KEY = 'quill:recent'
const MAX = 8

export function getRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as RecentEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function addRecent(entry: Omit<RecentEntry, 'openedAt'>): void {
  const list = getRecent().filter((e) => e.path !== entry.path)
  list.unshift({ ...entry, openedAt: Date.now() })
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
}

export function removeRecent(path: string): void {
  const list = getRecent().filter((e) => e.path !== path)
  localStorage.setItem(KEY, JSON.stringify(list))
}

export function clearRecent(): void {
  localStorage.removeItem(KEY)
}
