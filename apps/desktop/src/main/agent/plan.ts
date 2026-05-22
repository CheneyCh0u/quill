import { z } from 'zod'
import { streamObject } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'
import type { Scope } from './scope'

const MAX_BUFFER_CHARS = 3000

export const PlanStepSchema = z.object({
  id: z.string().min(1).describe('Short stable identifier, e.g. "s1"'),
  title: z
    .string()
    .min(1)
    .refine((s) => s.trim().length > 0, 'title must not be blank')
    .describe('Imperative one-line description of what this step accomplishes'),
  why: z
    .string()
    .optional()
    .describe('Optional rationale — why this step is needed'),
  files: z
    .array(z.string())
    .optional()
    .describe('Optional list of file paths this step is expected to touch')
})

export const PlanSchema = z.object({
  steps: z.array(PlanStepSchema).min(1).max(20)
})

export type PlanStep = z.infer<typeof PlanStepSchema>
export type Plan = z.infer<typeof PlanSchema>

/**
 * System prompt for the Plan agent. The planner has no tools — it just thinks
 * out loud and emits a structured list of steps that the Build agent will
 * execute next.
 */
export function buildPlanSystemPrompt(scope: Scope, currentBuffer?: string): string {
  const lines: string[] = []
  lines.push('You are the Plan agent for Quill.')
  lines.push('')
  lines.push(
    'Your job: turn a user request into a short ordered plan that a separate ' +
      'Build agent will execute. You have no tools. Do not call read_file or ' +
      'any other tool — output the plan only.'
  )
  lines.push('')
  lines.push('Keep plans tight (2–8 steps for most tasks). Each step must be:')
  lines.push('- A concrete, single-purpose action with a verb in its title.')
  lines.push('- Sequenced — earlier steps unblock later ones.')
  lines.push(
    '- Bounded — name the files it touches when known. If discovery is needed ' +
      'first, the first step can be an exploration step (e.g. "read X to find Y").'
  )
  lines.push('')
  lines.push(
    "After you produce the plan, the Build agent receives it verbatim and is " +
      'instructed to follow it. So write steps the Build agent (which has ' +
      'read/write tools) can execute directly.'
  )
  lines.push('')

  if (scope.kind === 'workspace') {
    lines.push(`Scope: workspace at ${scope.root} — Build can read/write files here.`)
  } else if (scope.kind === 'single-file') {
    lines.push(
      `Scope: single file at ${scope.path} — Build can only operate on this exact file.`
    )
  } else {
    lines.push(
      'Scope: untitled — no file system access. Build cannot touch disk; ' +
        'plan steps should be edits to the in-memory buffer only.'
    )
  }

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

  return lines.join('\n')
}

type PlanToolCallPart = {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
}
type PlanToolResultOutput =
  | { type: 'json'; value: unknown }
  | { type: 'error-json'; value: unknown }
  | { type: 'execution-denied'; reason?: string }
type PlanToolResultPart = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: PlanToolResultOutput
}
type PlanAssistantPart = { type: 'text'; text: string } | PlanToolCallPart

export type PlanHistoryMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | PlanAssistantPart[] }
  | { role: 'tool'; content: PlanToolResultPart[] }

export type PlanRunArgs = {
  model: LanguageModel
  prompt: string
  scope: Scope
  history?: PlanHistoryMessage[]
  currentBuffer?: string
  abortSignal?: AbortSignal
}

export type PlanStreamResult = {
  /** Async iterable of partial plan objects (steps array grows over time). */
  partial: AsyncIterable<Partial<Plan>>
  /** Resolves with the final, fully-validated plan once streaming ends. */
  final: Promise<Plan>
}

/**
 * Run the Plan agent. Returns a streaming handle so the orchestrator can emit
 * plan-step events as steps materialize, and a final promise for the validated
 * full plan.
 */
export function streamPlan(args: PlanRunArgs): PlanStreamResult {
  // Plan agent runs without tools, so tool messages in history would be
  // nonsense to it. Keep only user/assistant turns; assistant content is
  // accepted as either string or parts array.
  const planHistory = (args.history ?? []).filter(
    (m) => m.role === 'user' || m.role === 'assistant'
  ) as unknown as ModelMessage[]
  const result = streamObject({
    model: args.model,
    schema: PlanSchema,
    system: buildPlanSystemPrompt(args.scope, args.currentBuffer),
    messages: [...planHistory, { role: 'user', content: args.prompt }],
    abortSignal: args.abortSignal
  })
  return {
    partial: result.partialObjectStream as AsyncIterable<Partial<Plan>>,
    final: result.object as Promise<Plan>
  }
}
