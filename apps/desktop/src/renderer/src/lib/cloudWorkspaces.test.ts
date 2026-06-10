import { describe, expect, test } from 'bun:test'
import { pickCloudWorkspace } from './cloudWorkspaces'
import type { Workspace } from '../types'

const ws = (id: string, opts?: Partial<Workspace>): Workspace => ({
  id,
  name: id,
  remotePath: id,
  createdAt: 1,
  ...opts
})

describe('pickCloudWorkspace', () => {
  const list = [ws('a'), ws('quill', { default: true })]

  test('stored id wins when present', () => {
    expect(pickCloudWorkspace(list, 'a')?.id).toBe('a')
  })

  test('falls back to default, then first, then null', () => {
    expect(pickCloudWorkspace(list, null)?.id).toBe('quill')
    expect(pickCloudWorkspace([ws('x')], 'gone')?.id).toBe('x')
    expect(pickCloudWorkspace([], null)).toBeNull()
  })
})
