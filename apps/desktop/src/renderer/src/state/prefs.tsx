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
}

const DEFAULTS: Prefs = {
  fontSize: 14,
  defaultViewMode: 'split',
  showLineNumbers: true
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
          : DEFAULTS.showLineNumbers
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
