import { describe, expect, it } from 'bun:test'
import { RouteDecisionSchema, buildRouterSystemPrompt } from './router'
import type { Scope } from './scope'

describe('RouteDecisionSchema', () => {
  it('accepts a build decision', () => {
    const r = RouteDecisionSchema.safeParse({ agent: 'build', reason: 'simple one-file edit' })
    expect(r.success).toBe(true)
  })

  it('accepts a plan decision', () => {
    const r = RouteDecisionSchema.safeParse({ agent: 'plan', reason: 'touches many files' })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown agent value', () => {
    const r = RouteDecisionSchema.safeParse({ agent: 'router', reason: 'x' })
    expect(r.success).toBe(false)
  })

  it('rejects missing reason', () => {
    const r = RouteDecisionSchema.safeParse({ agent: 'build' })
    expect(r.success).toBe(false)
  })

  it('rejects blank reason', () => {
    const r = RouteDecisionSchema.safeParse({ agent: 'build', reason: '   ' })
    expect(r.success).toBe(false)
  })
})

describe('buildRouterSystemPrompt', () => {
  it('describes the binary choice and gives plan/build criteria', () => {
    const scope: Scope = { kind: 'workspace', root: '/r' }
    const p = buildRouterSystemPrompt(scope)
    expect(p).toMatch(/router|classifier|decide/i)
    expect(p).toContain('plan')
    expect(p).toContain('build')
    // Should give some hint about when each route is appropriate.
    expect(p).toMatch(/multi[- ]?step|multiple files|complex/i)
    expect(p).toMatch(/single|simple|direct/i)
  })

  it('workspace mode mentions scope kind', () => {
    const p = buildRouterSystemPrompt({ kind: 'workspace', root: '/r' })
    expect(p).toMatch(/workspace|folder/i)
  })

  it('single-file mode tightens the plan threshold', () => {
    // Single-file scope rarely benefits from a plan — narrow scope means
    // most edits are direct. The router prompt should hint at this so the
    // classifier biases toward build in single-file mode.
    const p = buildRouterSystemPrompt({ kind: 'single-file', path: '/r/x.md' })
    expect(p).toMatch(/single[- ]?file|narrow|prefer.*build/i)
  })

  it('untitled mode disables plan entirely', () => {
    // No fs access → no real multi-step build → plan adds no value.
    const p = buildRouterSystemPrompt({ kind: 'untitled' })
    expect(p).toMatch(/untitled|build only|always.*build/i)
  })
})
