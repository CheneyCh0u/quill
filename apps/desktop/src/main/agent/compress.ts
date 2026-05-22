import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

/**
 * System prompt for the compression agent. The trigger fires when the
 * Build model's input is approaching its context window — we summarize
 * the OLDER conversation turns so the next turn fits.
 *
 * Tuned for fidelity over brevity within reason — the model is told what
 * to preserve verbatim (file paths, decisions, errors, outstanding tasks)
 * and what to drop (small-talk, repeated reads). Output is markdown so
 * the panel renders it cleanly when shown.
 */
export function buildCompressionSystemPrompt(): string {
  return [
    'You are Quill — a markdown-first writing tool for macOS. Right now you',
    'are acting as the compression agent: your only job is to summarize the',
    'prior conversation between the user and another Quill agent so the next',
    'turn fits inside the model context window.',
    '',
    'Output: concise markdown, **at most 500 words**, in the same language',
    'the user has been using. No conversational filler, no opinions, no',
    'questions back to the user. Just the summary.',
    '',
    'You MUST preserve, verbatim or paraphrased:',
    '- Every **file path** that was read, written, or referenced.',
    '- Concrete **decisions** the user or agent made (e.g. "user picked',
    '  option B", "agent decided to skip step 3").',
    '- Any **errors** the agent hit and how they were resolved (or that',
    '  they remain unresolved).',
    '- Outstanding **tasks** the user implicitly or explicitly asked for',
    '  that have not been completed.',
    '',
    'You MAY drop:',
    '- Small talk, acknowledgements, restated questions.',
    '- Verbatim file contents that were read but not modified — keep just',
    '  the path and a one-line summary.',
    '- Multiple reads of the same file — record the latest state only.',
    '',
    'Do NOT invent facts. If you are unsure whether something happened,',
    'leave it out. Stay faithful to what is actually in the messages you',
    'are given.'
  ].join('\n')
}

export type CompressionResult = {
  summary: string
}

/**
 * Run the compression. Returns the summary text — the caller (renderer
 * or runCompression in index.ts) is responsible for splicing it into
 * items[] and persisting.
 */
export async function compressConversation(
  model: LanguageModel,
  messages: ModelMessage[],
  signal?: AbortSignal
): Promise<CompressionResult> {
  const result = await generateText({
    model,
    system: buildCompressionSystemPrompt(),
    messages,
    abortSignal: signal
  })
  return { summary: result.text }
}
