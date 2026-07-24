/// <reference types="bun" />
import { describe, it, expect } from 'bun:test'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('wraps tables in a horizontal-scroll container', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(html).toContain('<div class="table-wrap"><table>')
    expect(html).toContain('</table></div>')
  })
})
