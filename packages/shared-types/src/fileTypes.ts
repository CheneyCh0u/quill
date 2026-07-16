export type FileLanguage =
  | 'markdown'
  | 'javascript'
  | 'json'
  | 'html'
  | 'css'
  | 'xml'
  | 'python'
  | 'java'
  | 'go'
  | 'rust'
  | 'cpp'
  | 'sql'
  | 'php'
  | 'yaml'
  | 'shell'
  | 'ruby'
  | 'toml'
  | 'lua'
  | 'powershell'
  | 'r'
  | 'diff'

export type ViewableKind = 'image' | 'pdf'

export type FileTypeInfo = {
  isText: boolean
  isMarkdown: boolean
  language: FileLanguage | null
  /** View-only formats the app can display but never edit. null for text
   *  files (editable) and unknown binaries (not openable at all). */
  viewable: ViewableKind | null
}

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd'])

// View-only formats. svg is deliberately absent — it's editable xml and
// stays on the text/editor path.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico'])

const LANG_BY_EXT: Record<string, FileLanguage> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
  jsx: 'javascript',
  mts: 'javascript',
  cts: 'javascript',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  xml: 'xml',
  svg: 'xml',
  py: 'python',
  pyw: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  sql: 'sql',
  php: 'php',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  rb: 'ruby',
  toml: 'toml',
  lua: 'lua',
  ps1: 'powershell',
  r: 'r',
  diff: 'diff',
  patch: 'diff',
  // Vue / Svelte single-file components fall back to lang-html — tags and
  // attributes get coloured even if the <script>/<style> sections don't get
  // JS/CSS highlighting. Better than plain text.
  vue: 'html',
  svelte: 'html'
}

// Text files without dedicated syntax highlighting — editor falls back to
// plain text. Listed explicitly so we can distinguish from unknown binaries.
const PLAIN_TEXT_EXT = new Set([
  'txt',
  'log',
  'conf',
  'ini',
  'env',
  'csv',
  'tsv',
  'gitignore',
  'gitattributes',
  'gitmodules',
  'dockerignore',
  'editorconfig',
  'npmrc',
  'nvmrc',
  // Dotfile tooling configs (`.eslintrc`, `.babelrc`, …). `extOf` treats
  // the trailing token after a leading dot as the extension, so they hit
  // this lookup. Variants with a real extension (`.eslintrc.json` etc.)
  // get matched via the JSON / JS / YAML language lookups.
  'eslintrc',
  'babelrc',
  'prettierrc',
  'stylelintrc',
  'eslintignore',
  // Java / JVM configs and source files we don't have a CodeMirror lang
  // pack for. Editable, no highlighting.
  'properties',
  'kt',
  'kts',
  'swift',
  'scala',
  'dart',
  'gradle',
  'bat',
  'cmd'
])

// Filenames that are themselves text but carry no extension. Match
// case-insensitively against the basename.
const PLAIN_TEXT_FILENAMES = new Set([
  'readme',
  'license',
  'licence',
  'changelog',
  'authors',
  'contributors',
  'notice',
  'makefile',
  'dockerfile',
  'procfile'
])

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

function extOf(name: string): string {
  // For dotfiles like ".env" / ".gitignore" treat the trailing token as the
  // extension so the white-list lookup works.
  if (name.startsWith('.') && name.lastIndexOf('.') === 0) {
    return name.slice(1).toLowerCase()
  }
  const i = name.lastIndexOf('.')
  if (i <= 0) return ''
  return name.slice(i + 1).toLowerCase()
}

export function getFileType(path: string): FileTypeInfo {
  const name = basename(path)
  const ext = extOf(name)

  if (ext && MARKDOWN_EXT.has(ext)) {
    return { isText: true, isMarkdown: true, language: 'markdown', viewable: null }
  }

  if (ext && ext in LANG_BY_EXT) {
    return { isText: true, isMarkdown: false, language: LANG_BY_EXT[ext], viewable: null }
  }

  if (ext && PLAIN_TEXT_EXT.has(ext)) {
    return { isText: true, isMarkdown: false, language: null, viewable: null }
  }

  if (!ext && PLAIN_TEXT_FILENAMES.has(name.toLowerCase())) {
    return { isText: true, isMarkdown: false, language: null, viewable: null }
  }

  if (ext && IMAGE_EXT.has(ext)) {
    return { isText: false, isMarkdown: false, language: null, viewable: 'image' }
  }

  if (ext === 'pdf') {
    return { isText: false, isMarkdown: false, language: null, viewable: 'pdf' }
  }

  return { isText: false, isMarkdown: false, language: null, viewable: null }
}

export function isSupportedTextFile(path: string): boolean {
  return getFileType(path).isText
}

export function isViewableFile(path: string): boolean {
  return getFileType(path).viewable !== null
}

/** All supported extensions (no leading dot) — used for dialog filters etc. */
export function allTextExtensions(): string[] {
  return [
    ...MARKDOWN_EXT,
    ...Object.keys(LANG_BY_EXT),
    ...PLAIN_TEXT_EXT
  ]
}
