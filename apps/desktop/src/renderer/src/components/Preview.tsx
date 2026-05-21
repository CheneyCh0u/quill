import { useMemo } from 'react'
import { render } from '../lib/markdown'

type Props = {
  value: string
  /** Callback ref for the scrolling container. OutlineRail uses this to
   *  follow the user's reading position. */
  scrollRef?: (el: HTMLDivElement | null) => void
}

export function Preview({ value, scrollRef }: Props) {
  const html = useMemo(() => render(value), [value])
  return (
    <div
      ref={scrollRef}
      className="h-full w-full overflow-auto px-10 py-10 bg-[var(--paper-dim)]"
    >
      <div className="prose-paper mx-auto" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
