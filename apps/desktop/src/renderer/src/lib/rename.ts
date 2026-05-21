export type RenameValidation =
  | { ok: true; newPath: string; newName: string }
  | { ok: false; error: string }

/**
 * Build the new on-disk path for a rename, validating the user-supplied name.
 *
 * - Trims whitespace
 * - Rejects empty / whitespace-only names
 * - Rejects names containing `/` or `\` (those are path separators, not names)
 * - Auto-appends the current file's extension when the new name has none;
 *   falls back to `.md` if the current path also has no extension
 */
export function validateRenameTarget(
  currentPath: string,
  raw: string
): RenameValidation {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: '名称不能为空' }
  }
  if (/[/\\]/.test(trimmed)) {
    return { ok: false, error: '名称不能包含 / 或 \\' }
  }

  const lastFwd = currentPath.lastIndexOf('/')
  const lastBack = currentPath.lastIndexOf('\\')
  const lastSep = Math.max(lastFwd, lastBack)
  const dir = lastSep >= 0 ? currentPath.slice(0, lastSep + 1) : ''
  const currentName = lastSep >= 0 ? currentPath.slice(lastSep + 1) : currentPath

  // Anchor at non-zero so leading-dot files (".gitignore") aren't treated as
  // pure-extension.
  const hasExt = /[^.]\.[^.]+$/.test(trimmed)
  const currentExtMatch = currentName.match(/[^.]\.([^.]+)$/)
  const currentExt = currentExtMatch ? `.${currentExtMatch[1]}` : '.md'
  const finalName = hasExt ? trimmed : trimmed + currentExt

  return { ok: true, newPath: dir + finalName, newName: finalName }
}
