import { useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown'

export function Preview({ source }: { source: string }): JSX.Element {
  const html = useMemo(() => renderMarkdown(source), [source])
  return (
    <article
      className="prose-paper px-6 sm:px-10 py-8"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
