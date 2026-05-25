/**
 * Theme types + built-in registry. Shared so apps/desktop, apps/web,
 * and (eventually) server agree on the wire format for custom themes
 * loaded from `~/.quill/themes/*.json`.
 *
 * Surface tokens (paper / ink / rule / accent) live here as TS types
 * because custom themes ship them as JSON and we need to validate.
 * Syntax-highlight tokens (`--hl-*`) are mode-keyed in CSS only —
 * v1 of the custom theme schema doesn't expose them.
 */

export type ThemeMode = 'light' | 'dark'

/** Whether the editor follows the OS appearance or is locked. */
export type ThemePref = 'light' | 'dark' | 'system'

/**
 * The surface tokens a custom theme can override. CSS hex / oklch /
 * rgb strings are all accepted at runtime — the validator just
 * confirms the field is a non-empty string. Optional fields fall
 * back to the parent theme (see `extends` in the JSON schema).
 */
export type ThemeTokens = {
  paper: string
  paperDim: string
  paperSoft: string
  paperEdge: string
  ink: string
  inkSoft: string
  inkFaint: string
  inkGhost: string
  rule: string
  ruleSoft: string
  accent: string
  accentSoft: string
}

/** Complete theme definition — built-in or loaded from a JSON file.
 *  Named `ThemeDef` (not `Theme`) so it doesn't collide with renderer-local
 *  `Theme = 'light' | 'dark'`, which is older and used in more places. */
export type ThemeDef = {
  id: string
  name: string
  /** True for the themes baked into tokens.css; false for user JSON. */
  builtin: boolean
  light: ThemeTokens
  dark: ThemeTokens
}

// ------------------------------------------------------------
// Built-in themes
// ------------------------------------------------------------
// Token values for built-in themes live in CSS — runtime never
// reads them from JS. This list is the source of truth for which
// IDs the renderer is allowed to mount under [data-theme="<id>-light"]
// without supplying inline styles.

export const BUILTIN_THEME_IDS = ['claude', 'mono', 'ocean', 'solarized'] as const
export type BuiltinThemeId = (typeof BUILTIN_THEME_IDS)[number]

export const BUILTIN_THEME_NAMES: Record<BuiltinThemeId, string> = {
  claude: 'Claude',
  mono: 'Mono',
  ocean: 'Ocean',
  solarized: 'Solarized'
}

export const DEFAULT_THEME_ID: BuiltinThemeId = 'claude'

/** Type-guard so callers can narrow a string from disk / prefs. */
export function isBuiltinThemeId(id: string): id is BuiltinThemeId {
  return (BUILTIN_THEME_IDS as readonly string[]).includes(id)
}
