import { renderMarkdown } from './markdown'

/**
 * Browser file download helpers. Each function turns the open file into
 * a blob and triggers an `<a download>` click.
 *
 * Filenames inherit the source basename — "notes/draft.md" → "draft.md"
 * / "draft.html" / "draft.pdf" — so the user doesn't have to type one
 * in the OS save dialog.
 */

function basename(path: string): string {
  const last = path.split('/').pop() ?? path
  return last.replace(/\.(md|markdown|mdown|mkd)$/i, '')
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  // Defer revoke so Safari/Firefox have time to start the download
  // before the URL becomes invalid.
  setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 100)
}

/** Raw markdown — what's currently in the editor buffer, byte-for-byte. */
export function downloadAsMarkdown(path: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  triggerDownload(blob, `${basename(path)}.md`)
}

/** Standalone HTML — wraps the rendered markdown in a complete document
 *  with paper.css-derived inline styles. Opens nicely in any browser
 *  without external CSS. */
export function downloadAsHtml(path: string, content: string): void {
  const body = renderMarkdown(content)
  const html = buildStandaloneHtml(basename(path), body)
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  triggerDownload(blob, `${basename(path)}.html`)
}

/**
 * PDF via the browser's native print → "Save as PDF" flow. Opens a
 * hidden iframe with the rendered content + print-friendly inline CSS
 * and calls window.print() on it. User picks "Save as PDF" in the
 * print dialog. Cheaper than server-side puppeteer and works offline.
 */
export function printAsPdf(path: string, content: string): void {
  const body = renderMarkdown(content)
  const html = buildStandaloneHtml(basename(path), body)
  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.left = '-9999px'
  iframe.style.top = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.setAttribute('aria-hidden', 'true')
  document.body.appendChild(iframe)
  // Inject via srcdoc so the iframe shares no cross-origin baggage.
  iframe.srcdoc = html
  // Wait for the iframe document to be ready, then print + clean up.
  iframe.onload = () => {
    const w = iframe.contentWindow
    if (!w) {
      iframe.remove()
      return
    }
    // Give print CSS one tick to apply before the dialog opens.
    setTimeout(() => {
      try {
        w.focus()
        w.print()
      } finally {
        // Remove after a generous delay — print() is synchronous in
        // some browsers, async in others. 2s is enough for the dialog
        // to grab a snapshot of the document before we detach.
        setTimeout(() => iframe.remove(), 2000)
      }
    }, 50)
  }
}

/**
 * Inline-styled standalone HTML. Mirrors the paper.css selectors enough
 * that downloads render close-enough to the in-app preview without
 * shipping the full theme. Light theme only — print-to-PDF wants dark
 * backgrounds to wash out anyway.
 */
function buildStandaloneHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --paper: #f5f0e6;
    --ink: #2b2a26;
    --ink-soft: #4d4a44;
    --ink-faint: #8a857c;
    --rule: #d6cfc2;
    --accent: #b5482e;
    --paper-soft: #ece6da;
  }
  body {
    margin: 0;
    padding: 2.5rem max(1.5rem, 5vw);
    background: var(--paper);
    color: var(--ink);
    font-family: "Geist", "Noto Sans SC", -apple-system, system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.75;
    max-width: 64ch;
    margin-left: auto;
    margin-right: auto;
  }
  h1, h2, h3, h4, h5, h6 {
    font-family: "Fraunces", "Noto Serif SC", Georgia, serif;
    color: var(--ink);
    font-weight: 500;
    line-height: 1.25;
    margin: 1.6em 0 0.6em;
  }
  h1 { font-size: 2rem; }
  h2 { font-size: 1.4rem; }
  h3 { font-size: 1.15rem; }
  p {
    font-family: "Noto Serif SC", "Fraunces", Georgia, serif;
    color: var(--ink-soft);
    margin: 0 0 1rem;
  }
  a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
  code {
    background: var(--paper-soft);
    color: var(--ink);
    padding: 0.1em 0.4em;
    border-radius: 4px;
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 0.86em;
  }
  pre {
    background: var(--paper-soft);
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 12px 14px;
    overflow-x: auto;
    font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 13px;
    line-height: 1.6;
  }
  pre code { background: transparent; padding: 0; }
  blockquote {
    font-style: italic;
    border-left: 2px solid var(--accent);
    padding: 0.1rem 0 0.1rem 0.9rem;
    color: var(--ink-soft);
    margin: 0 0 1rem;
  }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 2rem 0; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 1rem; }
  th, td { padding: 0.5rem 0.7rem; border: 1px solid var(--rule); text-align: left; }
  th { background: var(--paper-soft); font-weight: 600; }
  img { max-width: 100%; border-radius: 6px; margin: 1rem 0; }
  ul, ol { margin: 0 0 1rem; padding-left: 1.4rem; }
  li { margin-bottom: 0.25rem; }

  @media print {
    /* Print CSS — drop background tint, switch to default fonts where
     * the user's machine likely lacks the brand ones. */
    body { background: white; padding: 0; }
    pre, code { background: #f6f4f0; }
    a { color: inherit; text-decoration: underline; }
    @page { margin: 1in; }
  }
</style>
</head>
<body>
${body}
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
