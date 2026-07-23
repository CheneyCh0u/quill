import { describe, expect, it } from 'bun:test'
import { decideFileRefresh } from './file-refresh'

describe('decideFileRefresh', () => {
  it.each([
    ['unchanged editor and disk', 'old', 'old', 'old', 'unchanged'],
    ['disk-only change', 'old', 'old', 'disk', 'reload'],
    ['editor-only change', 'old', 'editor', 'old', 'unchanged'],
    ['different two-sided changes', 'old', 'editor', 'disk', 'conflict'],
    ['matching two-sided changes', 'old', 'same', 'same', 'reload']
  ] as const)('%s', (_label, known, buffer, disk, expected) => {
    expect(decideFileRefresh(known, buffer, disk)).toBe(expected)
  })
})
