import type { Plan } from './plan'

/**
 * Pause queue between Plan and Build. Mirrors approvals.ts but per-runId
 * (there's only one plan per run, no toolCallId equivalent) and the
 * response carries the edited plan when approved.
 *
 * Cancelling a run resolves the pending plan approval as `{ approved: false }`
 * so runAgent can clean up and emit a finish event without hanging.
 */
export type PlanApprovalResponse = { approved: true; plan: Plan } | { approved: false }

type Entry = {
  runId: string
  plan: Plan
  resolve: (r: PlanApprovalResponse) => void
}

export function createPlanApprovalsManager() {
  const entries = new Map<string, Entry>()

  function request(runId: string, plan: Plan): Promise<PlanApprovalResponse> {
    return new Promise<PlanApprovalResponse>((resolve) => {
      // Defensive: a second request for the same runId resolves the first
      // as dismissed so the previous awaiter doesn't leak.
      const existing = entries.get(runId)
      if (existing) {
        existing.resolve({ approved: false })
      }
      entries.set(runId, { runId, plan, resolve })
    })
  }

  function respond(runId: string, response: PlanApprovalResponse): boolean {
    const entry = entries.get(runId)
    if (!entry) return false
    entries.delete(runId)
    entry.resolve(response)
    return true
  }

  function cancelRun(runId: string): number {
    const entry = entries.get(runId)
    if (!entry) return 0
    entries.delete(runId)
    entry.resolve({ approved: false })
    return 1
  }

  function pending(runId: string): { plan: Plan } | null {
    const e = entries.get(runId)
    return e ? { plan: e.plan } : null
  }

  return { request, respond, cancelRun, pending }
}

export type PlanApprovalsManager = ReturnType<typeof createPlanApprovalsManager>
