import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEME_NAMES,
  DEFAULT_THEME_ID,
  isBuiltinThemeId,
  type BuiltinThemeId,
  type ThemeDef
} from '@quill/shared-types'
import type { Theme, ThemeMode, ThemePref } from '../types'
import { ipc } from '../lib/ipc'
import { composeThemeAttribute } from '../lib/themeAttribute'
import { parseThemeJson } from '../lib/themeSchema'
import { applyCustomTokens, clearCustomTokens } from '../lib/customTheme'

const PREF_KEY = 'quill:theme'
const THEME_ID_KEY = 'quill:themeId'

function getStoredPref(): ThemePref {
  const v = localStorage.getItem(PREF_KEY)
  if (v === 'light' || v === 'dark' || v === 'system') return v
  return 'system'
}

function getStoredThemeId(): string {
  return localStorage.getItem(THEME_ID_KEY) ?? DEFAULT_THEME_ID
}

function resolveMode(pref: ThemePref): ThemeMode {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return pref
}

export type ThemeDescriptor = {
  id: string
  name: string
  builtin: boolean
}

type Ctx = {
  pref: ThemePref
  /** Resolved light / dark — what the data-theme suffix becomes. */
  theme: Theme
  /** Active theme family id. */
  themeId: string
  /** Built-in + custom themes the picker should offer. */
  availableThemes: ThemeDescriptor[]
  /** Reload custom themes from `~/.quill/themes/`. Called after import. */
  reloadCustomThemes: () => Promise<void>
  /** The full ThemeDef for the active theme — null for built-ins
   *  (their tokens live in CSS, not JS). Settings UI uses this to
   *  render an "export current theme" button on customs. */
  activeCustomTheme: ThemeDef | null
  setPref: (p: ThemePref) => void
  setThemeId: (id: string) => void
  cyclePref: () => void
}

const ThemeContext = createContext<Ctx | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => getStoredPref())
  const [theme, setTheme] = useState<Theme>(() => resolveMode(getStoredPref()))
  const [themeId, setThemeIdState] = useState<string>(() => getStoredThemeId())
  const [customThemes, setCustomThemes] = useState<ThemeDef[]>([])

  // Sync pref → mode, listen on system change while in `system` mode.
  useEffect(() => {
    localStorage.setItem(PREF_KEY, pref)
    setTheme(resolveMode(pref))
    if (pref !== 'system') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setTheme(resolveMode('system'))
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [pref])

  // Persist + propagate themeId so a second window picks the change up.
  useEffect(() => {
    localStorage.setItem(THEME_ID_KEY, themeId)
  }, [themeId])

  // Other windows mutating either key — re-read both so this window stays
  // in lockstep without ping-ponging events.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === PREF_KEY) setPrefState(getStoredPref())
      else if (e.key === THEME_ID_KEY) setThemeIdState(getStoredThemeId())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const reloadCustomThemes = useCallback(async (): Promise<void> => {
    try {
      const entries = await ipc.themes.list()
      const parsed: ThemeDef[] = []
      for (const e of entries) {
        const r = parseThemeJson(e.raw)
        if (r.ok) parsed.push(r.theme)
      }
      setCustomThemes(parsed)
    } catch {
      // Theme folder unavailable / first run before mkdir — leave the
      // list as it was (likely empty), no need to surface.
    }
  }, [])

  // First mount: load custom themes from disk.
  useEffect(() => {
    void reloadCustomThemes()
  }, [reloadCustomThemes])

  // Find the active theme. Built-in ids resolve to `null` (their tokens
  // live in CSS); custom ids look up by file id; unknown ids fall back
  // to the default built-in so a stale localStorage value can't lock
  // the app into a broken state.
  const { activeId, activeCustomTheme } = useMemo(() => {
    if (isBuiltinThemeId(themeId)) {
      return { activeId: themeId as BuiltinThemeId, activeCustomTheme: null }
    }
    const custom = customThemes.find((t) => t.id === themeId)
    if (custom) return { activeId: themeId, activeCustomTheme: custom }
    return { activeId: DEFAULT_THEME_ID, activeCustomTheme: null }
  }, [themeId, customThemes])

  // Cache the previous element we wrote inline tokens to so the cleanup
  // can reach them across renders without resorting to a global query.
  const styledElRef = useRef<HTMLElement | null>(null)

  // Single source of truth for the <html data-theme="…"> attribute,
  // plus the inline-tokens push/pull for custom themes.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = composeThemeAttribute(activeId, theme)
    if (activeCustomTheme) {
      applyCustomTokens(root, activeCustomTheme[theme])
      styledElRef.current = root
    } else if (styledElRef.current) {
      clearCustomTokens(styledElRef.current)
      styledElRef.current = null
    }
  }, [activeId, theme, activeCustomTheme])

  const availableThemes = useMemo<ThemeDescriptor[]>(() => {
    const builtins: ThemeDescriptor[] = BUILTIN_THEME_IDS.map((id) => ({
      id,
      name: BUILTIN_THEME_NAMES[id],
      builtin: true
    }))
    const customs: ThemeDescriptor[] = customThemes.map((t) => ({
      id: t.id,
      name: t.name,
      builtin: false
    }))
    return [...builtins, ...customs]
  }, [customThemes])

  const setPref = useCallback((p: ThemePref) => setPrefState(p), [])
  const setThemeId = useCallback((id: string) => setThemeIdState(id), [])
  const cyclePref = useCallback(() => {
    setPrefState((p) => (p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system'))
  }, [])

  return (
    <ThemeContext.Provider
      value={{
        pref,
        theme,
        themeId,
        availableThemes,
        reloadCustomThemes,
        activeCustomTheme,
        setPref,
        setThemeId,
        cyclePref
      }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): Ctx {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}
