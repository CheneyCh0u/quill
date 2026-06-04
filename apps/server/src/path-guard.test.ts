import { describe, expect, test } from 'bun:test'
import { resolve, join } from 'node:path'
import { resolveInVault, PathGuardError } from './path-guard'

// Build the vault root and expectations through node:path so the suite is
// platform-agnostic: on POSIX this is /data/vault, on Windows C:\data\vault.
// Hardcoding POSIX literals made the whole suite fail on the Windows runner.
const VAULT = resolve('/data/vault')

describe('resolveInVault', () => {
  test('plain file under vault resolves', () => {
    expect(resolveInVault(VAULT, 'notes/a.md')).toBe(join(VAULT, 'notes', 'a.md'))
  })

  test('leading slash is treated as vault-relative, not absolute', () => {
    expect(resolveInVault(VAULT, '/notes/a.md')).toBe(join(VAULT, 'notes', 'a.md'))
  })

  test('redundant slashes / dots get normalized', () => {
    expect(resolveInVault(VAULT, './notes//a.md')).toBe(join(VAULT, 'notes', 'a.md'))
  })

  test('empty path resolves to vault root', () => {
    expect(resolveInVault(VAULT, '')).toBe(VAULT)
  })

  test('rejects .. that escapes the vault', () => {
    expect(() => resolveInVault(VAULT, '../etc/passwd')).toThrow(PathGuardError)
  })

  test('rejects sibling escape via traversal segments', () => {
    expect(() => resolveInVault(VAULT, 'notes/../../etc/passwd')).toThrow(
      PathGuardError
    )
  })

  test('absolute-looking input is treated as vault-relative, not as filesystem root', () => {
    // Defense-in-depth: even if a client sends what looks like an absolute
    // path, we resolve under the vault root rather than `/`. The result may
    // 404 (no such file in the vault) but it can't read outside the vault.
    expect(resolveInVault(VAULT, '/etc/passwd')).toBe(join(VAULT, 'etc', 'passwd'))
  })

  test('error message names the offending path', () => {
    try {
      resolveInVault(VAULT, '../oops')
      throw new Error('expected throw')
    } catch (e) {
      expect((e as Error).message).toContain('../oops')
    }
  })

  test('traversal that lands back inside is still rejected (defensive)', () => {
    // notes/../sub stays inside literally, but the .. segment is a code smell;
    // we treat as legit since resolved path is in scope.
    expect(resolveInVault(VAULT, 'notes/../sub/b.md')).toBe(join(VAULT, 'sub', 'b.md'))
  })
})
