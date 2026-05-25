/// <reference types="bun" />
import { describe, it, expect } from 'bun:test'
import { getTokenAssignments, CSS_VAR_BY_KEY } from './customTheme'

const tokens = {
  paper: '#ffffff',
  paperDim: '#f4f4f4',
  paperSoft: '#eaeaea',
  paperEdge: '#dcdcdc',
  ink: '#111111',
  inkSoft: '#333333',
  inkFaint: '#666666',
  inkGhost: '#999999',
  rule: '#cccccc',
  ruleSoft: '#e2e2e2',
  accent: '#cc3333',
  accentSoft: '#f4d8d8'
}

describe('getTokenAssignments', () => {
  it('produces a (cssVar, value) pair for every token field', () => {
    const pairs = getTokenAssignments(tokens)
    expect(pairs).toHaveLength(12)
    expect(pairs).toContainEqual(['--paper', '#ffffff'])
    expect(pairs).toContainEqual(['--paper-dim', '#f4f4f4'])
    expect(pairs).toContainEqual(['--ink-soft', '#333333'])
    expect(pairs).toContainEqual(['--accent', '#cc3333'])
    expect(pairs).toContainEqual(['--accent-soft', '#f4d8d8'])
  })

  it('uses kebab-case CSS variable names matching tokens.css', () => {
    // The map is the contract with packages/core/styles/tokens.css —
    // a typo here would silently leave the CSS variable at its default
    // value, hard to debug. Lock it in.
    expect(CSS_VAR_BY_KEY.paper).toBe('--paper')
    expect(CSS_VAR_BY_KEY.paperDim).toBe('--paper-dim')
    expect(CSS_VAR_BY_KEY.paperSoft).toBe('--paper-soft')
    expect(CSS_VAR_BY_KEY.paperEdge).toBe('--paper-edge')
    expect(CSS_VAR_BY_KEY.ink).toBe('--ink')
    expect(CSS_VAR_BY_KEY.inkSoft).toBe('--ink-soft')
    expect(CSS_VAR_BY_KEY.inkFaint).toBe('--ink-faint')
    expect(CSS_VAR_BY_KEY.inkGhost).toBe('--ink-ghost')
    expect(CSS_VAR_BY_KEY.rule).toBe('--rule')
    expect(CSS_VAR_BY_KEY.ruleSoft).toBe('--rule-soft')
    expect(CSS_VAR_BY_KEY.accent).toBe('--accent')
    expect(CSS_VAR_BY_KEY.accentSoft).toBe('--accent-soft')
  })
})
