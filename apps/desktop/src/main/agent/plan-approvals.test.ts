import { describe, expect, test } from 'bun:test'
import { createPlanApprovalsManager } from './plan-approvals'

const samplePlan = { steps: [{ id: 's1', title: 'do thing' }] }

describe('plan approvals manager', () => {
  test('request returns a promise that resolves on matching respond', async () => {
    const m = createPlanApprovalsManager()
    const p = m.request('run-1', samplePlan)
    queueMicrotask(() =>
      m.respond('run-1', { approved: true, plan: samplePlan })
    )
    const r = await p
    expect(r.approved).toBe(true)
    if (r.approved) expect(r.plan).toEqual(samplePlan)
  })

  test('dismissed response carries approved=false (no plan field)', async () => {
    const m = createPlanApprovalsManager()
    const p = m.request('run-1', samplePlan)
    queueMicrotask(() => m.respond('run-1', { approved: false }))
    const r = await p
    expect(r.approved).toBe(false)
  })

  test('respond returns true on hit, false on miss', () => {
    const m = createPlanApprovalsManager()
    m.request('run-1', samplePlan)
    expect(m.respond('run-1', { approved: true, plan: samplePlan })).toBe(true)
    expect(m.respond('run-missing', { approved: true, plan: samplePlan })).toBe(false)
  })

  test('respond for already-resolved approval returns false', async () => {
    const m = createPlanApprovalsManager()
    const p = m.request('run-1', samplePlan)
    m.respond('run-1', { approved: true, plan: samplePlan })
    await p
    expect(m.respond('run-1', { approved: false })).toBe(false)
  })

  test('cancelRun resolves a pending approval as approved=false', async () => {
    const m = createPlanApprovalsManager()
    const p = m.request('run-A', samplePlan)
    m.request('run-B', samplePlan)
    const n = m.cancelRun('run-A')
    expect(n).toBe(1)
    const r = await p
    expect(r.approved).toBe(false)
    // run-B still pending
    expect(m.respond('run-B', { approved: false })).toBe(true)
  })

  test('cancelRun on unknown runId returns 0', () => {
    const m = createPlanApprovalsManager()
    expect(m.cancelRun('nope')).toBe(0)
  })

  test('only one pending approval per runId — a second request overwrites the first as cancelled', async () => {
    // Defensive: a second plan emission for the same run shouldn't happen in
    // practice (runAgent only emits once), but if it does, the old promise
    // must resolve so the previous awaiter doesn't leak.
    const m = createPlanApprovalsManager()
    const first = m.request('run-1', samplePlan)
    m.request('run-1', { steps: [{ id: 's2', title: 'other' }] })
    const r1 = await first
    expect(r1.approved).toBe(false)
  })
})
