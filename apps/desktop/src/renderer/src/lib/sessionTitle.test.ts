import { describe, expect, test } from 'bun:test'
import { deriveSessionTitle } from './sessionTitle'

describe('deriveSessionTitle', () => {
  test('takes the first user prompt', () => {
    expect(
      deriveSessionTitle([
        { kind: 'assistant', text: 'hi' },
        { kind: 'user', text: '帮我整理笔记' },
        { kind: 'user', text: '第二条' }
      ])
    ).toBe('帮我整理笔记')
  })

  test('collapses whitespace and truncates to 24 chars', () => {
    expect(deriveSessionTitle([{ kind: 'user', text: '  a \n  b   c  ' }])).toBe('a b c')
    const long = '这是一段非常非常长的提问内容，会超过二十四个字符的截断阈值'
    const t = deriveSessionTitle([{ kind: 'user', text: long }])
    expect(t).toBe(long.slice(0, 24) + '…')
  })

  test('no user item → empty string (UI shows 新会话)', () => {
    expect(deriveSessionTitle([])).toBe('')
    expect(deriveSessionTitle([{ kind: 'assistant', text: 'x' }])).toBe('')
  })
})
