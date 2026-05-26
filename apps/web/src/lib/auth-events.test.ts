import { describe, expect, test } from 'bun:test'
import { notifyUnauthorized, onUnauthorized } from './auth-events'

describe('auth-events', () => {
  test('notify fires every listener', () => {
    let a = 0
    let b = 0
    const offA = onUnauthorized(() => (a += 1))
    const offB = onUnauthorized(() => (b += 1))
    notifyUnauthorized()
    expect(a).toBe(1)
    expect(b).toBe(1)
    offA()
    offB()
  })

  test('unsubscribe stops further callbacks', () => {
    let n = 0
    const off = onUnauthorized(() => (n += 1))
    notifyUnauthorized()
    off()
    notifyUnauthorized()
    expect(n).toBe(1)
  })
})
