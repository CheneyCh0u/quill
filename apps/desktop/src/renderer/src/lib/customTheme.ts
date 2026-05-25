import type { ThemeTokens } from '@quill/shared-types'

/**
 * camelCase → kebab-case mapping for the surface tokens, matching
 * the variable names declared in `packages/core/styles/tokens.css`.
 *
 * Kept as an explicit map (instead of a regex transform) so a typo
 * here surfaces at build time as a missing key, rather than silently
 * writing `--paperdim` while the CSS file reads `--paper-dim`.
 */
export const CSS_VAR_BY_KEY: Record<keyof ThemeTokens, string> = {
  paper: '--paper',
  paperDim: '--paper-dim',
  paperSoft: '--paper-soft',
  paperEdge: '--paper-edge',
  ink: '--ink',
  inkSoft: '--ink-soft',
  inkFaint: '--ink-faint',
  inkGhost: '--ink-ghost',
  rule: '--rule',
  ruleSoft: '--rule-soft',
  accent: '--accent',
  accentSoft: '--accent-soft'
}

/** Flatten a `ThemeTokens` into [cssVarName, value] pairs. */
export function getTokenAssignments(tokens: ThemeTokens): Array<[string, string]> {
  return (Object.keys(CSS_VAR_BY_KEY) as Array<keyof ThemeTokens>).map((k) => [
    CSS_VAR_BY_KEY[k],
    tokens[k]
  ])
}

/**
 * Push custom theme tokens onto an element via inline style. The CSS
 * cascade lets these win over the `[data-theme="<id>-<mode>"]` blocks
 * in `tokens.css`, so a custom theme can override a built-in's surface
 * without touching `--hl-*` (those still come from the data-theme rule).
 */
export function applyCustomTokens(el: HTMLElement, tokens: ThemeTokens): void {
  for (const [varName, value] of getTokenAssignments(tokens)) {
    el.style.setProperty(varName, value)
  }
}

/** Remove any inline tokens previously written by `applyCustomTokens`. */
export function clearCustomTokens(el: HTMLElement): void {
  for (const varName of Object.values(CSS_VAR_BY_KEY)) {
    el.style.removeProperty(varName)
  }
}
