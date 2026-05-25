import type { ThemeMode } from '@quill/shared-types'

/**
 * Encode (themeId, mode) into the `<html data-theme="…">` value that
 * `packages/core/styles/tokens.css` keys its selectors on.
 *
 * The convention is `<themeId>-<light|dark>`. Theme IDs can contain
 * hyphens (custom themes are file-named, "my-theme.json" is valid),
 * so the encoding is non-ambiguous only by reading the LAST hyphen
 * — see `parseThemeAttribute`.
 */
export function composeThemeAttribute(themeId: string, mode: ThemeMode): string {
  return `${themeId}-${mode}`
}

/**
 * Inverse of `composeThemeAttribute`. Returns `null` on values the
 * renderer can't interpret (missing mode suffix, empty themeId,
 * unknown mode) so callers can fall back to the default theme
 * rather than crashing on a stored attribute they no longer
 * recognise.
 */
export function parseThemeAttribute(
  attr: string
): { themeId: string; mode: ThemeMode } | null {
  const lastDash = attr.lastIndexOf('-')
  if (lastDash <= 0 || lastDash === attr.length - 1) return null
  const themeId = attr.slice(0, lastDash)
  const tail = attr.slice(lastDash + 1)
  if (tail !== 'light' && tail !== 'dark') return null
  return { themeId, mode: tail }
}
