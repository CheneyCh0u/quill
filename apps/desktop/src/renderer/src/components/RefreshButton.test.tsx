import { expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RefreshButton } from './RefreshButton'

it('marks a pending refresh as disabled and animated', () => {
  const html = renderToStaticMarkup(
    <RefreshButton label="刷新文件" refreshing onClick={() => undefined} />
  )
  expect(html).toContain('aria-label="刷新文件"')
  expect(html).toContain('disabled=""')
  expect(html).toContain('animate-spin')
  expect(html).toContain('motion-reduce:animate-none')
})
