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
      className="h-full w-full overflow-auto pl-[clamp(2.5rem,17%,280px)] pr-[min(max(17%,272px),45%,280px)] py-10 bg-[var(--paper-dim)]"
    >
      <div className="prose-paper" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
