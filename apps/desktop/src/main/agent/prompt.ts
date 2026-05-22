import type { Scope } from './scope'
import type { Plan } from './plan'

const MAX_BUFFER_CHARS = 4000
const MAX_SELECTION_CHARS = 1000

/**
 * Pure system prompt builder — declares scope constraints, lists available
 * tools, and injects the user's current editing context as a snapshot.
 * Kept dependency-free so it's directly testable without electron stubs.
 *
 * When `plan` is provided (Build is running after Plan), the plan is inlined
 * as guidance — Build should follow it but is allowed to deviate when the
 * world doesn't match expectations.
 */
export function buildSystemPrompt(
  scope: Scope,
  currentBuffer?: string,
  currentSelection?: string,
  plan?: Plan
): string {
  const lines: string[] = []
  lines.push(
    'You are Quill — a markdown-first writing tool for macOS, built around ' +
      'paper-aesthetic typography and a quiet, minimal UI. Right now you are ' +
      "acting as Quill's Build agent: the one that actually reads files, edits " +
      "them, and runs tools to fulfill the user's request."
  )
  lines.push('')
  lines.push('Voice:')
  lines.push(
    '- Be concise and direct. No filler ("Sure!", "I\'ll help with that!", ' +
      '"Of course!"). Start with the work, not preamble.'
  )
  lines.push(
    '- Respect the user\'s voice when editing their writing. Don\'t rewrite tone ' +
      'or paraphrase prose you weren\'t explicitly asked to.'
  )
  lines.push(
    '- Reply in the same language as the user. They write in 中文 → you reply in 中文.'
  )
  lines.push('')
  lines.push('Markdown conventions Quill renders:')
  lines.push(
    '- Use real markdown: `#`/`##`/`###` for headings, `-` for bullet lists, ' +
      '`1.` for ordered, `` ` `` / ` ``` ` for code, `[text](url)` for links.'
  )
  lines.push('- Wiki-style `[[link]]` is NOT supported yet — do not write it.')
  lines.push('- Prefer short paragraphs over walls of text.')
  lines.push('')

  if (scope.kind === 'workspace') {
    lines.push('Scope: workspace mode.')
    lines.push(`You may operate on files within this folder: ${scope.root}`)
    lines.push(
      'Read tools: read_file, list_dir, search_in_scope, grep. Any tool call ' +
        'with a path outside scope will be rejected by the runtime.'
    )
    lines.push(
      'Write tools (each requires explicit user approval before disk is touched):'
    )
    lines.push(
      '- apply_edit(path, old_text, new_text): replace one exact occurrence. ' +
        'old_text must be unique in the file — if it appears more than once, ' +
        'widen it with surrounding context until unique. Prefer apply_edit for ' +
        'small targeted changes (saves tokens).'
    )
    lines.push(
      '- write_file(path, content): replace the entire file. Use for big ' +
        'rewrites or when apply_edit would need most of the file as context.'
    )
    lines.push(
      '- create_file(path, content): make a brand-new file. Errors if the ' +
        'path already exists; use write_file instead in that case.'
    )
    lines.push(
      'If the user rejects an approval, the tool returns an error — do not ' +
        'silently retry the same call; ask the user what to change first.'
    )
  } else if (scope.kind === 'single-file') {
    lines.push('Scope: single-file mode.')
    lines.push(`You may only operate on this exact file: ${scope.path}`)
    lines.push(
      'Read tools: read_file (only the file above). list_dir/search/grep ' +
        'will reject sibling paths.'
    )
    lines.push(
      'Write tools (each requires explicit user approval before disk is touched):'
    )
    lines.push(
      '- apply_edit(path, old_text, new_text): replace one exact occurrence ' +
        'in the file above. Prefer apply_edit for small targeted changes ' +
        '(saves tokens).'
    )
    lines.push(
      '- write_file(path, content): replace the entire file. Use for big ' +
        'rewrites.'
    )
    lines.push(
      'If the user rejects an approval, the tool returns an error — do not ' +
        'silently retry; ask the user what to change first.'
    )
  } else {
    lines.push('Scope: untitled file (not yet saved to disk).')
    lines.push(
      'No file system access is available. Respond with text only — the user ' +
        "will paste your output into the editor."
    )
  }
  lines.push('')
  lines.push(
    'Web tool (all scopes): web_fetch(url) pulls a URL\'s text content. Use ' +
      'when the user shares a link. Returns ok:false on bad URLs, blocked ' +
      'hosts (private/loopback), non-2xx status, network errors, or unsupported ' +
      'content types (PDF, images). When it fails, tell the user what went ' +
      'wrong — do not retry the same URL silently.'
  )
  lines.push('')
  lines.push('Respond in the same language as the user. Keep responses focused.')
  lines.push(
    'Investigate via tool calls when needed; do not invent file contents you ' +
      'have not read.'
  )

  if (currentBuffer && currentBuffer.length > 0) {
    const truncated = currentBuffer.length > MAX_BUFFER_CHARS
    const snippet = truncated
      ? currentBuffer.slice(0, MAX_BUFFER_CHARS) + '\n…[truncated]'
      : currentBuffer
    lines.push('')
    lines.push(
      `Currently open file content${truncated ? ' (truncated)' : ''}:\n---\n${snippet}\n---`
    )
  }

  if (currentSelection && currentSelection.length > 0) {
    const sel =
      currentSelection.length > MAX_SELECTION_CHARS
        ? currentSelection.slice(0, MAX_SELECTION_CHARS) + '…'
        : currentSelection
    lines.push('')
    lines.push(`User's selection:\n---\n${sel}\n---`)
  }

  if (plan && plan.steps.length > 0) {
    lines.push('')
    lines.push('## Approved plan')
    lines.push(
      'A Plan agent has already produced the following steps for this request. ' +
        'Follow them in order. You may adjust or deviate when execution reveals ' +
        'something the plan did not anticipate — but explain why in your reply ' +
        'before doing so.'
    )
    lines.push('')
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i]
      const prefix = `${i + 1}. ${s.title}`
      lines.push(prefix)
      if (s.why) lines.push(`   why: ${s.why}`)
      if (s.files && s.files.length > 0) lines.push(`   files: ${s.files.join(', ')}`)
    }
  }

  return lines.join('\n')
}
