import { z } from 'zod'
import { generateObject } from 'ai'
import type { LanguageModel } from 'ai'
import type { Scope } from './scope'

export const RouteDecisionSchema = z.object({
  agent: z.enum(['plan', 'build']).describe('Which agent should handle this request'),
  reason: z
    .string()
    .min(1)
    .refine((s) => s.trim().length > 0, 'reason must not be blank')
    .describe('One short sentence explaining the choice — surfaced to the user')
})

export type RouteDecision = z.infer<typeof RouteDecisionSchema>

/**
 * System prompt for the Router. The router is a cheap intent classifier that
 * decides whether a request needs a Plan→Build chain or can go straight to
 * Build. Output is always a {agent, reason} JSON object.
 *
 * Heuristics encoded:
 * - Plan when: multi-file, ambiguous goal, spans more than ~3 logical steps,
 *   the user explicitly asks for an outline / approach / breakdown.
 * - Build when: single edit, single-file question, direct one-shot task.
 * - In single-file scope, bias toward Build (scope is too narrow for a plan
 *   to add real value).
 * - In untitled scope, always Build (no fs means no real Build workflow to
 *   plan; the model just composes text inline).
 */
export function buildRouterSystemPrompt(scope: Scope): string {
  const lines: string[] = []
  lines.push('You are the routing classifier for Quill.')
  lines.push('')
  lines.push(
    'Decide whether this user request should go through a Plan-then-Build ' +
      'flow ("plan") or be executed directly by the Build agent ("build").'
  )
  lines.push('')
  lines.push('Choose **plan** when:')
  lines.push('- The request implies a multi-step change touching multiple files.')
  lines.push('- The goal is ambiguous and benefits from being broken down first.')
  lines.push('- The user explicitly asks for an outline, approach, or breakdown.')
  lines.push('')
  lines.push('Choose **build** when:')
  lines.push('- The request is a single, simple, direct edit or question.')
  lines.push('- The user wants information, not a multi-step transformation.')
  lines.push('- The work fits naturally in one or two tool calls.')
  lines.push('')

  if (scope.kind === 'single-file') {
    lines.push(
      'Scope is single-file — prefer build unless the user explicitly asks for ' +
        'a plan; the narrow scope rarely needs a plan to add value.'
    )
  } else if (scope.kind === 'untitled') {
    lines.push(
      'Scope is untitled (no file system) — always choose build. Plan adds ' +
        'no value when there is no multi-step build workflow.'
    )
  } else {
    lines.push(`Scope is a workspace at ${scope.root}.`)
  }
  lines.push('')
  lines.push('Respond with the schema: { agent: "plan" | "build", reason: string }.')
  lines.push("Reason should be one short sentence that's surfaced to the user.")
  return lines.join('\n')
}

export type RouterRunArgs = {
  model: LanguageModel
  prompt: string
  scope: Scope
  abortSignal?: AbortSignal
}

/**
 * Run the Router once and return the decision. No streaming — the router
 * output is tiny and we need the whole thing before deciding the next phase.
 */
export async function classifyIntent(args: RouterRunArgs): Promise<RouteDecision> {
  // Untitled scope is hardcoded to build — skip the LLM call entirely.
  if (args.scope.kind === 'untitled') {
    return { agent: 'build', reason: 'untitled scope — fs-less, go straight to build' }
  }
  const result = await generateObject({
    model: args.model,
    schema: RouteDecisionSchema,
    system: buildRouterSystemPrompt(args.scope),
    messages: [{ role: 'user', content: args.prompt }],
    abortSignal: args.abortSignal
  })
  return result.object as RouteDecision
}
