import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import { slugify } from './outline'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch {
        /* fall through to plain rendering */
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`
  }
})

// Inject id="<slug>" onto every heading so the outline panel's
// click-to-scroll target exists in the DOM. Disambiguates duplicates the
// same way buildOutline() does — keeps both sides aligned without a
// shared data structure.
md.renderer.rules.heading_open = (tokens, idx) => {
  const open = tokens[idx]
  const inline = tokens[idx + 1]
  const text = inline?.type === 'inline' ? (inline.content ?? '').trim() : ''
  const base = slugify(text) || `h-${idx}`
  // markdown-it re-renders for each call; carry a counter on the renderer
  // env or fall back to per-call counts via env. We use env directly so a
  // single render() pass disambiguates.
  const env = (tokens as unknown as { env?: { slugCounts?: Map<string, number> } }).env
  if (env && !env.slugCounts) env.slugCounts = new Map()
  const counts: Map<string, number> = env?.slugCounts ?? new Map()
  const seen = counts.get(base) ?? 0
  const slug = seen === 0 ? base : `${base}-${seen + 1}`
  counts.set(base, seen + 1)
  return `<${open.tag} id="${slug}">`
}

// Wrap tables in a scroll container so wide tables pan horizontally inside
// .table-wrap (styled in prose-paper.css) instead of overflowing the pane.
md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n'
md.renderer.rules.table_close = () => '</table></div>\n'

export function renderMarkdown(src: string): string {
  // env is per-render so duplicate-slug counters reset between calls.
  return md.render(src, { slugCounts: new Map<string, number>() })
}
