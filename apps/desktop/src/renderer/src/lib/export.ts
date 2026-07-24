import type { Theme } from '../types'
import { render } from './markdown'
import { ipc } from './ipc'

/**
 * Walk all same-origin stylesheets and serialize their rules. Tailwind, our
 * custom CSS (including hljs theme), and Vite-injected dev styles all live in
 * document.styleSheets, so this picks them all up. Cross-origin sheets throw
 * on cssRules access; we skip those silently.
 */
function collectCss(): string {
  const parts: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    if (!rules) continue
    for (const rule of Array.from(rules)) {
      parts.push(rule.cssText)
    }
  }
  return parts.join('\n')
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}

const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,300..900,30..100,0..1;1,9..144,300..900,30..100,0..1&family=Geist:wght@300..700&family=Noto+Serif+SC:wght@400..700&family=Noto+Sans+SC:wght@300..600&display=swap" />`

type TemplateArgs = {
  body: string
  css: string
  theme: Theme
  title: string
}

/**
 * Pure template — DOM-free so it's unit-testable. Wraps the rendered
 * markdown body in a self-contained HTML document with embedded styles
 * and a link to the Paper-UI font stack (Fraunces / Geist / Noto SC).
 * Both the PDF exporter and the HTML exporter feed through here.
 */
export function buildHtmlTemplate({ body, css, theme, title }: TemplateArgs): string {
  return `<!doctype html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
${FONT_LINK}
<style>
@page { margin: 18mm 16mm; }

html, body { background: var(--paper, #fff); }
body {
  margin: 0;
  padding: 0;
  font-family: "Geist", "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  color-scheme: ${theme};
}

/* Bundled app CSS (Tailwind + hljs theme + prose-paper) */
${css}

/* Print-specific tweaks */
.export-root { padding: 32px 40px; }
pre, blockquote, table { page-break-inside: avoid; }
h1, h2, h3, h4 { page-break-after: avoid; }
img { max-width: 100%; height: auto; }

/* Paper can't scroll: on print, tables fall back to full-width wrapping */
@media print {
  .prose-paper .table-wrap { overflow-x: visible; }
  .prose-paper table { width: 100%; }
  .prose-paper th, .prose-paper td { max-width: none; }
}
</style>
</head>
<body data-theme="${theme}">
<div class="export-root">
<article class="prose-paper" style="max-width: 64ch; margin: 0 auto;">
${body}
</article>
</div>
</body>
</html>`
}

type BuildArgs = {
  markdown: string
  theme: Theme
  title: string
}

export function buildExportHtml(args: BuildArgs): string {
  const body = render(args.markdown)
  const css = collectCss()
  return buildHtmlTemplate({ body, css, theme: args.theme, title: args.title })
}

export type ExportArgs = {
  markdown: string
  defaultName: string
  theme: Theme
}

export async function exportToPdf(args: ExportArgs): Promise<string | null> {
  const html = buildExportHtml({
    markdown: args.markdown,
    theme: args.theme,
    title: args.defaultName.replace(/\.pdf$/i, '')
  })
  return ipc.exportPdf({ html, defaultName: args.defaultName })
}

export async function exportToHtml(args: ExportArgs): Promise<string | null> {
  const title = args.defaultName.replace(/\.html?$/i, '')
  const html = buildExportHtml({ markdown: args.markdown, theme: args.theme, title })
  const path = await ipc.saveFileDialog(args.defaultName, [
    { name: 'HTML', extensions: ['html', 'htm'] }
  ])
  if (!path) return null
  await ipc.vault.write(path, html)
  return path
}
