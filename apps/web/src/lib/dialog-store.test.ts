import { describe, expect, test } from 'bun:test'
import { DialogStore, type DialogRequest } from './dialog-store'

function fakeReq(resolve: (v: unknown) => void): DialogRequest {
  return { kind: 'alert', opts: { message: 'x' }, resolve }
}

describe('DialogStore', () => {
  test('current() returns null when queue empty', () => {
    const s = new DialogStore()
    expect(s.current()).toBeNull()
  })

  test('enqueue + current returns first request', () => {
    const s = new DialogStore()
    let resolved: unknown = 'untouched'
    s.enqueue(fakeReq((v) => (resolved = v)))
    expect(s.current()?.kind).toBe('alert')
    expect(resolved).toBe('untouched')
  })

  test('resolveCurrent calls resolver and pops the queue', () => {
    const s = new DialogStore()
    let a: unknown = null
    let b: unknown = null
    s.enqueue(fakeReq((v) => (a = v)))
    s.enqueue(fakeReq((v) => (b = v)))
    s.resolveCurrent('first')
    expect(a).toBe('first')
    expect(s.current()?.kind).toBe('alert')
    expect(b).toBeNull()
    s.resolveCurrent('second')
    expect(b).toBe('second')
    expect(s.current()).toBeNull()
  })

  test('resolveCurrent on empty queue is a no-op', () => {
    const s = new DialogStore()
    expect(() => s.resolveCurrent(null)).not.toThrow()
  })

  test('subscribe fires after enqueue / resolveCurrent', () => {
    const s = new DialogStore()
    let n = 0
    const off = s.subscribe(() => (n += 1))
    s.enqueue(fakeReq(() => undefined))
    s.resolveCurrent(null)
    expect(n).toBe(2)
    off()
    s.enqueue(fakeReq(() => undefined))
    expect(n).toBe(2)
  })
})
