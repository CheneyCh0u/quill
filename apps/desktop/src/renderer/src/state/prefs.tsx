import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from 'react'
import type { ViewMode } from '../types'

export type Prefs = {
  /** CodeMirror editor font size in px. */
  fontSize: number
  /** Initial viewMode for files opened from now on (split / edit / preview). */
  defaultViewMode: ViewMode
  /** Show the gutter with line numbers in the editor. */
  showLineNumbers: boolean
  /** Extension (without dot) used for the next Cmd+N / untitled save.
   *  Updated to whatever the user picks in the save dialog so subsequent
   *  new files default to the same kind. */
  lastNewFileExt: string
  /** Auto-sync sync-enabled folder workspaces in the background.
   *  Conflicts are never auto-resolved. */
  autoSync: boolean
  /** Minutes between auto-sync passes. */
  autoSyncIntervalMin: AutoSyncInterval
}

export type AutoSyncInterval = 1 | 5 | 15 | 30

const DEFAULTS: Prefs = {
  fontSize: 14,
  defaultViewMode: 'split',
  showLineNumbers: true,
  lastNewFileExt: 'md',
  autoSync: false,
  autoSyncIntervalMin: 5
}

const STORAGE_KEY = 'quill:prefs'

function readStored(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Prefs>
    return {
      fontSize:
        typeof parsed.fontSize === 'number' &&
        parsed.fontSize >= 10 &&
        parsed.fontSize <= 24
          ? parsed.fontSize
          : DEFAULTS.fontSize,
      defaultViewMode:
        parsed.defaultViewMode === 'edit' ||
        parsed.defaultViewMode === 'split' ||
        parsed.defaultViewMode === 'preview'
          ? parsed.defaultViewMode
          : DEFAULTS.defaultViewMode,
      showLineNumbers:
        typeof parsed.showLineNumbers === 'boolean'
          ? parsed.showLineNumbers
          : DEFAULTS.showLineNumbers,
      lastNewFileExt:
        typeof parsed.lastNewFileExt === 'string' &&
        /^[a-z0-9]+$/i.test(parsed.lastNewFileExt) &&
        parsed.lastNewFileExt.length <= 12
          ? parsed.lastNewFileExt.toLowerCase()
          : DEFAULTS.lastNewFileExt,
      autoSync:
        typeof parsed.autoSync === 'boolean' ? parsed.autoSync : DEFAULTS.autoSync,
      autoSyncIntervalMin:
        parsed.autoSyncIntervalMin === 1 ||
        parsed.autoSyncIntervalMin === 5 ||
        parsed.autoSyncIntervalMin === 15 ||
        parsed.autoSyncIntervalMin === 30
          ? parsed.autoSyncIntervalMin
          : DEFAULTS.autoSyncIntervalMin
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function applyFontSizeVar(px: number): void {
  document.documentElement.style.setProperty('--editor-font-size', `${px}px`)
}

type Ctx = {
  prefs: Prefs
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void
}

const PrefsContext = createContext<Ctx | null>(null)

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(() => readStored())

  // Push to localStorage + CSS var whenever prefs change locally.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
    } catch {
      /* localStorage unavailable; silently skip */
    }
    applyFontSizeVar(prefs.fontSize)
  }, [prefs])

  // Pick up changes from other windows (settings window updating prefs while
  // main window stays open). `storage` event fires in OTHER same-origin
  // windows when localStorage is mutated.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== STORAGE_KEY) return
      setPrefs(readStored())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setPref = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((p) => ({ ...p, [key]: value }))
  }, [])

  return (
    <PrefsContext.Provider value={{ prefs, setPref }}>{children}</PrefsContext.Provider>
  )
}

export function usePrefs(): Ctx {
  const ctx = useContext(PrefsContext)
  if (!ctx) throw new Error('usePrefs must be used inside PrefsProvider')
  return ctx
}
