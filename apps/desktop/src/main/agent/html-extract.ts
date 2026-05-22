/**
 * Lightweight HTML → text extraction for the web_fetch tool. Pure regex,
 * no DOM deps — accurate enough for "give the model the gist" without
 * pulling in cheerio/jsdom (~hundreds of KB).
 *
 * Steps, in order:
 *   1. Grab the first `<title>` text (titles in `<head>` are the usual signal).
 *   2. Strip whole `<script>`, `<style>`, `<noscript>`, `<nav>`, `<header>`,
 *      `<footer>`, `<aside>`, `<iframe>` blocks (open-to-close, case-insensitive).
 *   3. Strip remaining HTML tags.
 *   4. Decode common HTML entities (named + numeric).
 *   5. Collapse whitespace.
 *
 * Limitation: malformed/unclosed tags will trip the regex strip. We don't try
 * to recover — the model can still work with what falls out, and the worst
 * case is some leftover tag fragments in the text.
 */

export type ExtractResult = {
  title?: string
  text: string
}

const STRIP_BLOCKS = [
  'script',
  'style',
  'noscript',
  'nav',
  'header',
  'footer',
  'aside',
  'iframe'
]

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

export function extractText(html: string): ExtractResult {
  if (!html) return { text: '' }

  // 1. Title
  let title: string | undefined
  const tMatch = html.match(TITLE_RE)
  if (tMatch) {
    const decoded = decodeEntities(tMatch[1]).replace(/\s+/g, ' ').trim()
    if (decoded) title = decoded
  }

  // 2. Strip nuisance blocks
  let body = html
  for (const tag of STRIP_BLOCKS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi')
    body = body.replace(re, ' ')
  }
  // Also strip <head> wholesale — its useful bits (title) we already pulled.
  body = body.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')

  // 3. Strip remaining tags
  body = body.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')

  // 4. Decode entities
  body = decodeEntities(body)

  // 5. Collapse whitespace
  body = body.replace(/\s+/g, ' ').trim()

  return { title, text: body }
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named ?? whole
  })
}
