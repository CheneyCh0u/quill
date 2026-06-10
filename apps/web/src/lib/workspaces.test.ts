import { describe, expect, test } from 'bun:test'
import { pickActiveWorkspace } from './workspaces'
import type { Workspace } from '@quill/shared-types'

const ws = (id: string, opts?: Partial<Workspace>): Workspace => ({
  id,
  name: id,
  remotePath: id,
  createdAt: 1,
  ...opts
})

describe('pickActiveWorkspace', () => {
  const list = [ws('a'), ws('quill', { default: true }), ws('b')]

  test('returns the stored choice when it still exists', () => {
    expect(pickActiveWorkspace(list, 'b')?.id).toBe('b')
  })

  test('falls back to the default workspace for unknown/absent stored id', () => {
    expect(pickActiveWorkspace(list, 'gone')?.id).toBe('quill')
    expect(pickActiveWorkspace(list, null)?.id).toBe('quill')
  })

  test('no default flag → first entry; empty list → null', () => {
    expect(pickActiveWorkspace([ws('x'), ws('y')], null)?.id).toBe('x')
    expect(pickActiveWorkspace([], null)).toBeNull()
  })
})
