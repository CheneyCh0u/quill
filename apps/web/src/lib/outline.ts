/**
 * Markdown outline parser.
 *
 * Walks markdown-it's token stream once and extracts the document's
 * heading structure. The slug we generate must match what the renderer
 * puts into the rendered HTML's `<h1 id="...">` — both sides feed the
 * same slugify() so click-to-scroll works without each side knowing
 * about the other.
 */

import MarkdownIt from 'markdown-it'

export type OutlineNode = {
  /** 1-6, matches the heading level (h1 = 1, h2 = 2, …). */
  level: number
  text: string
  /** DOM id assigned to the heading in the rendered preview. */
  slug: string
}

/**
 * Make a URL-safe slug from heading text. Mirrors the simple normalize
 * used inside our renderer — strip punctuation, replace whitespace with
 * dashes, lowercase. Non-ASCII (CJK) survives, which is fine since the
 * id is used directly via `element.id` and matched as a string.
 *
 * Duplicate-counter logic is applied at the parse layer (see `buildOutline`)
 * so the slug is unique within a document.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    // Strip leading hash markers, asterisks, backticks from the text.
    .replace(/[`*_~]/g, '')
    // Spaces / dashes / dots become a single dash.
    .replace(/[\s./]+/g, '-')
    // Drop everything that's not letter, digit, dash, or CJK.
    .replace(/[^\w一-鿿-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Parse markdown source into a flat list of headings. Resolves slug
 * collisions by appending -2, -3, etc. so `[[anchor]]` is unambiguous.
 */
export function buildOutline(source: string): OutlineNode[] {
  const md = new MarkdownIt()
  const tokens = md.parse(source, {})
  const nodes: OutlineNode[] = []
  const counts = new Map<string, number>()
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'heading_open') continue
    const level = Number(t.tag.slice(1))
    // inline token sits between heading_open and heading_close.
    const inline = tokens[i + 1]
    const text = inline?.type === 'inline' ? (inline.content ?? '').trim() : ''
    if (!text) continue
    const base = slugify(text)
    if (!base) continue
    const seen = counts.get(base) ?? 0
    const slug = seen === 0 ? base : `${base}-${seen + 1}`
    counts.set(base, seen + 1)
    nodes.push({ level, text, slug })
  }
  return nodes
}
