import { z } from 'zod'
import type { ThemeDef, ThemeTokens } from '@quill/shared-types'

// Each token is a non-empty string. We don't try to validate that the
// value is a real CSS colour — CSS itself accepts `red`, `oklch(...)`,
// `var(--x)`, etc., and an invalid value gets ignored by the browser
// without crashing the app. Rejecting on a typo we can't really detect
// would be worse than letting it through.
const tokenValue = z.string().min(1)

const tokensShape = {
  paper: tokenValue,
  paperDim: tokenValue,
  paperSoft: tokenValue,
  paperEdge: tokenValue,
  ink: tokenValue,
  inkSoft: tokenValue,
  inkFaint: tokenValue,
  inkGhost: tokenValue,
  rule: tokenValue,
  ruleSoft: tokenValue,
  accent: tokenValue,
  accentSoft: tokenValue
}

// `.strict()` would surface forward-compatibility hazards; `.strip()`
// (default) is more permissive. We default + filter, see below — that
// way a future field added to the schema doesn't break older Quill
// versions reading newer JSON.
const tokensSchema = z.object(tokensShape)

const themeJsonSchema = z.object({
  // ID becomes a file name AND a CSS data-theme attribute slug, so the
  // character class is intentionally narrow: alphanumerics + - + _.
  // No spaces, no slashes, no dots.
  id: z
    .string()
    .min(1)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
      'id must start with a letter or digit and contain only letters, digits, "-", or "_"'
    ),
  name: z.string().min(1),
  light: tokensSchema,
  dark: tokensSchema
})

export type ParseResult =
  | { ok: true; theme: ThemeDef }
  | { ok: false; error: string }

/**
 * Validate raw JSON for a user-supplied theme. Returns a structured
 * result so the caller (settings UI / IPC importer) can surface a
 * message instead of crashing on bad input.
 *
 * Unknown fields are silently dropped — that way an older Quill can
 * load a theme written by a newer Quill without rejecting it outright.
 */
export function parseThemeJson(raw: unknown): ParseResult {
  const parsed = themeJsonSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const path = first.path.length > 0 ? first.path.join('.') : '(root)'
    return { ok: false, error: `${path}: ${first.message}` }
  }
  // safeParse already stripped unknown fields, but the tokens objects
  // might carry extras since their schema is open. Re-pick the known
  // keys so the resulting object matches `ThemeTokens` exactly.
  const pickTokens = (t: Record<string, unknown>): ThemeTokens => ({
    paper: t.paper as string,
    paperDim: t.paperDim as string,
    paperSoft: t.paperSoft as string,
    paperEdge: t.paperEdge as string,
    ink: t.ink as string,
    inkSoft: t.inkSoft as string,
    inkFaint: t.inkFaint as string,
    inkGhost: t.inkGhost as string,
    rule: t.rule as string,
    ruleSoft: t.ruleSoft as string,
    accent: t.accent as string,
    accentSoft: t.accentSoft as string
  })
  return {
    ok: true,
    theme: {
      id: parsed.data.id,
      name: parsed.data.name,
      builtin: false,
      light: pickTokens(parsed.data.light),
      dark: pickTokens(parsed.data.dark)
    }
  }
}
