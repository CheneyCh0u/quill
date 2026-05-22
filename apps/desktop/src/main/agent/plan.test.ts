import { describe, expect, it } from 'bun:test'
import { PlanSchema, buildPlanSystemPrompt } from './plan'
import type { Scope } from './scope'

describe('PlanSchema', () => {
  it('accepts a minimal valid plan', () => {
    const r = PlanSchema.safeParse({
      steps: [{ id: 's1', title: '读取 README' }]
    })
    expect(r.success).toBe(true)
  })

  it('accepts steps with optional why and files', () => {
    const r = PlanSchema.safeParse({
      steps: [
        {
          id: 's1',
          title: '新建 settings.md',
          why: '集中放配置文档',
          files: ['docs/settings.md']
        }
      ]
    })
    expect(r.success).toBe(true)
  })

  it('rejects empty steps array', () => {
    const r = PlanSchema.safeParse({ steps: [] })
    expect(r.success).toBe(false)
  })

  it('rejects step without title', () => {
    const r = PlanSchema.safeParse({ steps: [{ id: 's1' }] })
    expect(r.success).toBe(false)
  })

  it('rejects more than 20 steps', () => {
    const steps = Array.from({ length: 21 }, (_, i) => ({
      id: `s${i}`,
      title: `step ${i}`
    }))
    const r = PlanSchema.safeParse({ steps })
    expect(r.success).toBe(false)
  })

  it('rejects whitespace-only title', () => {
    const r = PlanSchema.safeParse({ steps: [{ id: 's1', title: '   ' }] })
    expect(r.success).toBe(false)
  })
})

describe('buildPlanSystemPrompt', () => {
  it('declares planner role and structured output requirement', () => {
    const scope: Scope = { kind: 'workspace', root: '/r' }
    const p = buildPlanSystemPrompt(scope)
    expect(p).toMatch(/plan/i)
    // No tools available to the planner — must be stated so the model doesn't
    // try to call any.
    expect(p).toMatch(/no tools|do not call|cannot call/i)
    // Tells the model that build will execute the plan afterward.
    expect(p).toMatch(/build|executor|execute/i)
  })

  it('workspace mode mentions root path', () => {
    const p = buildPlanSystemPrompt({ kind: 'workspace', root: '/work/notes' })
    expect(p).toContain('/work/notes')
  })

  it('single-file mode pins the file path', () => {
    const p = buildPlanSystemPrompt({ kind: 'single-file', path: '/r/x.md' })
    expect(p).toContain('/r/x.md')
  })

  it('untitled mode declares no fs access', () => {
    const p = buildPlanSystemPrompt({ kind: 'untitled' })
    expect(p).toMatch(/untitled|no file|disk/i)
  })

  it('injects current buffer when provided', () => {
    const p = buildPlanSystemPrompt({ kind: 'single-file', path: '/x.md' }, '# Hello')
    expect(p).toContain('# Hello')
  })
})
