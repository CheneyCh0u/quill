import { describe, it, expect } from 'bun:test'
import { scrollShouldClose } from './Select'

/** Minimal stand-in for the popover element — only `contains` matters. */
function popover(containsTarget: boolean) {
  return { contains: () => containsTarget }
}

describe('scrollShouldClose', () => {
  it('keeps the popover open when the scroll happens inside it (bug: 长模型列表无法滚动)', () => {
    expect(scrollShouldClose(popover(true), {})).toBe(false)
  })

  it('closes when an outside container scrolls', () => {
    expect(scrollShouldClose(popover(false), {})).toBe(true)
  })

  it('closes when the popover is not mounted', () => {
    expect(scrollShouldClose(null, {})).toBe(true)
  })
})
