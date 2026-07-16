import { describe, it, expect } from 'bun:test'
import { Command } from '@langchain/langgraph'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, Plan } from '@quill/shared-types'
import {
  createAgentGraph,
  createApprovalGate,
  AGENT_RECURSION_LIMIT,
  MAX_BUILD_STEPS,
  type GraphDeps,
  type StepResult
} from './graph'
import { makeTools } from './tools'
import type { Scope } from './scope'

/**
 * 图编排测试：LLM 缝隙（classify/plan/step）注入脚本化桩，工具走真实
 * makeTools + 临时目录（仓库规范：本地用真东西，只 mock 外部网络）。
 * 断言的是控制流行为：路由、审批 interrupt/resume、工具两遍执行、步数上限。
 */

const PLAN: Plan = { steps: [{ id: 's1', title: '改文件' }] }

function textStep(text: string): StepResult {
  return {
    finishReason: 'stop',
    toolCalls: [],
    responseMessages: [{ role: 'assistant', content: text }],
    usage: { totalTokens: 10 }
  }
}

function toolStep(name: string, args: unknown, id = `call-${name}`): StepResult {
  return {
    finishReason: 'tool-calls',
    toolCalls: [{ toolCallId: id, name, args }],
    responseMessages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: args }] }
    ],
    usage: { totalTokens: 5 }
  }
}

function harness(opts: {
  steps: StepResult[] | (() => StepResult)
  route?: 'plan' | 'build'
  mode?: 'auto' | 'plan' | 'build'
  scopeRoot?: string
}) {
  const root = opts.scopeRoot ?? mkdtempSync(join(tmpdir(), 'quill-graph-'))
  const scope: Scope = { kind: 'workspace', root }
  const events: AgentEvent[] = []
  const gate = createApprovalGate()
  const tools = makeTools(scope, gate.requestApproval)
  const stepQueue = Array.isArray(opts.steps) ? [...opts.steps] : null
  let classifyCalls = 0
  const deps: GraphDeps = {
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    mode: opts.mode ?? 'auto',
    approvalGate: gate,
    tools,
    classify: async () => {
      classifyCalls++
      return { agent: opts.route ?? 'build', reason: 'scripted' }
    },
    plan: async () => PLAN,
    step: async () => {
      if (stepQueue) {
        const next = stepQueue.shift()
        if (!next) throw new Error('step queue exhausted')
        return next
      }
      return (opts.steps as () => StepResult)()
    }
  }
  const graph = createAgentGraph(deps)
  const cfg = { configurable: { thread_id: 'run-t' }, recursionLimit: AGENT_RECURSION_LIMIT }
  return { graph, cfg, events, root, classifyCalls: () => classifyCalls }
}

describe('routing', () => {
  it('mode build goes straight to buildStep without classifying', async () => {
    const h = harness({ steps: [textStep('done')], mode: 'build' })
    const result = await h.graph.invoke({}, h.cfg)
    expect(h.classifyCalls()).toBe(0)
    expect(result.finishReason).toBe('stop')
    expect(h.events.some((e) => e.type === 'plan-delta')).toBe(false)
  })

  it('auto route=build classifies once and emits route-decision', async () => {
    const h = harness({ steps: [textStep('done')], mode: 'auto', route: 'build' })
    await h.graph.invoke({}, h.cfg)
    expect(h.classifyCalls()).toBe(1)
    expect(h.events.some((e) => e.type === 'route-decision')).toBe(true)
  })
})

describe('plan approval interrupt', () => {
  it('pauses after plan with a plan-approval interrupt, builds after approval', async () => {
    const h = harness({ steps: [textStep('built')], mode: 'plan' })
    const paused = (await h.graph.invoke({}, h.cfg)) as Record<string, unknown>
    const intr = (paused.__interrupt__ as Array<{ id: string; value: unknown }>)[0]
    expect(intr.value).toEqual({ kind: 'plan-approval', plan: PLAN })
    expect(h.events.some((e) => e.type === 'phase-start' && e.phase === 'plan')).toBe(true)
    // 未批准前不进 build
    expect(h.events.some((e) => e.type === 'phase-start' && e.phase === 'build')).toBe(false)

    const done = await h.graph.invoke(
      new Command({ resume: { [intr.id]: { approved: true, plan: PLAN } } }),
      h.cfg
    )
    expect(done.finishReason).toBe('stop')
    expect(h.events.some((e) => e.type === 'phase-start' && e.phase === 'build')).toBe(true)
  })

  it('rejected plan ends the run without building', async () => {
    const h = harness({ steps: [textStep('never')], mode: 'plan' })
    const paused = (await h.graph.invoke({}, h.cfg)) as Record<string, unknown>
    const intr = (paused.__interrupt__ as Array<{ id: string; value: unknown }>)[0]
    const done = await h.graph.invoke(
      new Command({ resume: { [intr.id]: { approved: false } } }),
      h.cfg
    )
    expect(done.planRejected).toBe(true)
    expect(done.finishReason).toBeUndefined()
  })
})

describe('tool loop', () => {
  it('executes a read tool without any interrupt and feeds the result back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quill-graph-'))
    writeFileSync(join(root, 'note.md'), 'hello quill')
    const h = harness({
      steps: [toolStep('read_file', { path: 'note.md' }), textStep('answer')],
      mode: 'build',
      scopeRoot: root
    })
    const result = (await h.graph.invoke({}, h.cfg)) as Record<string, unknown>
    expect(result.__interrupt__).toBeUndefined()
    expect(result.finishReason).toBe('stop')
    const toolResult = h.events.find((e) => e.type === 'tool-result')
    expect(toolResult && 'result' in toolResult && (toolResult.result as { ok: boolean }).ok).toBe(
      true
    )
  })

  it('write tool pauses with a batched tool-approval interrupt; approval commits to disk', async () => {
    const h = harness({
      steps: [toolStep('write_file', { path: 'out.md', content: 'v2' }, 'w1'), textStep('done')],
      mode: 'build'
    })
    const paused = (await h.graph.invoke({}, h.cfg)) as Record<string, unknown>
    const intr = (paused.__interrupt__ as Array<{ id: string; value: unknown }>)[0]
    const value = intr.value as {
      kind: string
      requests: Array<{ toolCallId: string; payload: Record<string, unknown> }>
    }
    expect(value.kind).toBe('tool-approval')
    expect(value.requests.length).toBe(1)
    expect(value.requests[0].toolCallId).toBe('w1')
    expect(value.requests[0].payload.kind).toBe('write_file')
    // interrupt 前不落盘
    expect(existsSync(join(h.root, 'out.md'))).toBe(false)

    const done = await h.graph.invoke(
      new Command({ resume: { [intr.id]: { w1: { approved: true } } } }),
      h.cfg
    )
    expect(done.finishReason).toBe('stop')
    expect(readFileSync(join(h.root, 'out.md'), 'utf-8')).toBe('v2')
  })

  it('denied write returns a tool error to the model and leaves disk untouched', async () => {
    const h = harness({
      steps: [toolStep('write_file', { path: 'out.md', content: 'v2' }, 'w1'), textStep('ok')],
      mode: 'build'
    })
    const paused = (await h.graph.invoke({}, h.cfg)) as Record<string, unknown>
    const intr = (paused.__interrupt__ as Array<{ id: string; value: unknown }>)[0]
    await h.graph.invoke(
      new Command({ resume: { [intr.id]: { w1: { approved: false, reason: 'nope' } } } }),
      h.cfg
    )
    expect(existsSync(join(h.root, 'out.md'))).toBe(false)
    const toolResult = h.events.find((e) => e.type === 'tool-result')
    expect(
      toolResult && 'result' in toolResult && (toolResult.result as { error?: string }).error
    ).toBe('nope')
  })

  it('stops the loop at MAX_BUILD_STEPS even when the model keeps calling tools', async () => {
    let n = 0
    const h = harness({
      steps: () => toolStep('list_dir', {}, `c${n++}`),
      mode: 'build'
    })
    const result = await h.graph.invoke({}, h.cfg)
    expect(result.stepCount).toBe(MAX_BUILD_STEPS)
  })
})
