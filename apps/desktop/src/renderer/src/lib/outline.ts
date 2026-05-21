import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

export type OutlineItem = {
  level: 1 | 2 | 3 | 4 | 5 | 6
  text: string
  slug: string
  line: number
}

// Slim markdown-it instance just for outline parsing. Kept separate from
// the rendering instance so plugin changes there can't break parsing.
const parser = new MarkdownIt({ html: false })

function extractText(inline: Token): string {
  if (!inline.children) return inline.content
  return inline.children
    .filter((c) => c.type === 'text' || c.type === 'code_inline')
    .map((c) => c.content)
    .join('')
    .trim()
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

export function parseOutline(source: string): OutlineItem[] {
  if (!source.trim()) return []
  const tokens = parser.parse(source, {})
  const raw: Array<Omit<OutlineItem, 'slug'>> = []

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'heading_open') continue
    const level = Number(t.tag.slice(1)) as OutlineItem['level']
    const inline = tokens[i + 1]
    const text = inline?.type === 'inline' ? extractText(inline) : ''
    const line = t.map?.[0] ?? 0
    raw.push({ level, text, line })
  }

  const counts = new Map<string, number>()
  return raw.map((it) => {
    const base = slugify(it.text) || `heading-${it.line}`
    const seen = counts.get(base) ?? 0
    counts.set(base, seen + 1)
    return { ...it, slug: seen === 0 ? base : `${base}-${seen}` }
  })
}
