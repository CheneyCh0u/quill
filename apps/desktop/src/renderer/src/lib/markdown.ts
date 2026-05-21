import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/common'
import { slugify } from './outline'

function highlight(str: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      const out = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
      return `<pre class="hljs"><code class="hljs language-${lang}">${out}</code></pre>`
    } catch {
      /* fall through */
    }
  }
  if (!lang) {
    try {
      const auto = hljs.highlightAuto(str)
      if (auto.language) {
        return `<pre class="hljs"><code class="hljs language-${auto.language}">${auto.value}</code></pre>`
      }
    } catch {
      /* fall through */
    }
  }
  const escaped = md.utils.escapeHtml(str)
  return `<pre class="hljs"><code class="hljs">${escaped}</code></pre>`
}

export const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: true,
  highlight
})

// Inject an `id` on every heading so the OutlinePanel can anchor-jump to it.
// Slug logic mirrors lib/outline.ts so outline.slug === heading.id. Per-render
// duplicate counts live in `env` (markdown-it creates a fresh `env` per call
// to md.render when none is passed).
const defaultHeadingOpen = md.renderer.rules.heading_open
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const inline = tokens[idx + 1]
  if (inline?.type === 'inline') {
    const text =
      inline.children
        ?.filter((c) => c.type === 'text' || c.type === 'code_inline')
        .map((c) => c.content)
        .join('')
        .trim() ?? ''
    const counts: Map<string, number> =
      env.__slugCounts ?? (env.__slugCounts = new Map<string, number>())
    const base = slugify(text) || `heading-${token.map?.[0] ?? 0}`
    const seen = counts.get(base) ?? 0
    counts.set(base, seen + 1)
    token.attrSet('id', seen === 0 ? base : `${base}-${seen}`)
  }
  return defaultHeadingOpen
    ? defaultHeadingOpen(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)
}

export function render(source: string): string {
  return md.render(source)
}

export function countWords(source: string): number {
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[*_~#>!\[\](){}]/g, ' ')
    .trim()
  if (!text) return 0
  const cjk = text.match(/[一-鿿぀-ヿ가-힯]/g)?.length ?? 0
  const latin = text.replace(/[一-鿿぀-ヿ가-힯]/g, ' ').match(/\b\w+\b/g)?.length ?? 0
  return cjk + latin
}
