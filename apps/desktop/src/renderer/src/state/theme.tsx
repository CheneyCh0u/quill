import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Theme, ThemePref } from '../types'

const STORAGE_KEY = 'quill:theme'

function getStoredPref(): ThemePref {
  const v = localStorage.getItem(STORAGE_KEY)
  if (v === 'light' || v === 'dark' || v === 'system') return v
  return 'system'
}

function resolveTheme(pref: ThemePref): Theme {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return pref
}

type Ctx = {
  pref: ThemePref
  theme: Theme
  setPref: (p: ThemePref) => void
  cyclePref: () => void
}

const ThemeContext = createContext<Ctx | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => getStoredPref())
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(getStoredPref()))

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, pref)
    setTheme(resolveTheme(pref))
    if (pref !== 'system') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setTheme(resolveTheme('system'))
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [pref])

  // Other windows (e.g. settings window) updating the theme key — pick up the
  // change and rerender so all open windows stay in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== STORAGE_KEY) return
      setPrefState(getStoredPref())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const setPref = useCallback((p: ThemePref) => setPrefState(p), [])
  const cyclePref = useCallback(() => {
    setPrefState((p) => (p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system'))
  }, [])

  return (
    <ThemeContext.Provider value={{ pref, theme, setPref, cyclePref }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): Ctx {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}
