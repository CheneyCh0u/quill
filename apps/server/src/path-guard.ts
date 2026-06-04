import { resolve as resolvePath, sep } from 'node:path'

/**
 * Thrown when a user-supplied path would escape the vault. Carries the
 * original request path so the API layer can surface a 400 with the
 * offending string. Never include the resolved absolute path in the
 * message — that's an information leak about the host filesystem.
 */
export class PathGuardError extends Error {
  constructor(public readonly userPath: string) {
    super(`path "${userPath}" escapes the vault`)
    this.name = 'PathGuardError'
  }
}

/**
 * Resolve a user-supplied path against the vault root and verify the result
 * stays inside.
 *
 * Behavior:
 * - Leading slashes are stripped (treated as vault-relative, not absolute).
 * - `.` and `..` segments are normalized by `path.resolve`.
 * - Empty path returns the vault root itself.
 * - Anything resolving outside the vault throws PathGuardError.
 *
 * Returns the absolute path safe to hand to fs APIs.
 */
export function resolveInVault(vaultRoot: string, userPath: string): string {
  const root = resolvePath(vaultRoot)
  // Strip leading slashes so absolute-looking inputs are treated as
  // vault-relative. Without this, resolve('/etc/passwd') against any base
  // would jump straight to /etc/passwd.
  const trimmed = userPath.replace(/^\/+/, '')
  const abs = resolvePath(root, trimmed)
  // Use the platform separator, not a literal '/': on Windows resolvePath
  // returns '\'-separated paths, so `root + '/'` would never match a legit
  // child and every path would falsely "escape the vault".
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new PathGuardError(userPath)
  }
  return abs
}
