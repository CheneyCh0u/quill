import { CODEX_API_ENDPOINT, type CodexTokens, type FetchLike } from './codex-auth'

/**
 * AI SDK 自定义 fetch：SDK 照常请求 api.openai.com/v1/responses，这里在
 * 传输层改写到 ChatGPT 订阅的 Codex 端点并注入订阅鉴权。四个端点怪癖
 * 也在这层兜住，上层 streamText / generateText 无感：
 *
 * 1. 不认 max_output_tokens（带上 400）→ 剥掉
 * 2. 强制 stream:true → 非流式请求转成流式发出，收拢 SSE 合成 JSON 返回
 * 3. response.completed 里 output 为空数组 → 从 response.output_item.done
 *    增量事件攒 item 拼回 output
 *
 * 另外订阅端点必须 store:false（不落库）且带回加密 reasoning 内容
 * （多轮工具调用需要）——同样在请求体里固定，免得每个调用点都要记。
 */

const USER_AGENT = 'quill/1.0'
const REASONING_INCLUDE = 'reasoning.encrypted_content'

function adaptCodexBody(init?: RequestInit): { init?: RequestInit; forcedStream: boolean } {
  if (typeof init?.body !== 'string') return { init, forcedStream: false }
  try {
    const body = JSON.parse(init.body)
    if (!body || typeof body !== 'object') return { init, forcedStream: false }
    delete body.max_output_tokens
    // 4) store:false 下服务端不保存 item：function_call 等 item 回传时
    //    带 id 会被当成库引用去查 → "Item with id 'fc_…' not found"，剥掉
    //    （call_id 是请求内 call/output 配对，保留）。唯一例外是 reasoning
    //    item —— 它的 id 是必填字段（缺了报 "Missing required parameter:
    //    'input[N].id'"），加密推理内容靠 id 自描述。
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (!item || typeof item !== 'object') continue
        const type = (item as { type?: string }).type
        // reasoning 的 id 是必填自描述；item_reference 的 id 是它的全部 —
        // 剥掉只会把「查不到」变成更迷惑的「缺参」（正常路径下 SDK 已被
        // STEP_PROVIDER_OPTIONS 挡住不发引用，这里只是不糟蹋诊断信息）。
        if (type === 'reasoning' || type === 'item_reference') continue
        delete (item as Record<string, unknown>).id
      }
    }
    body.store = false
    const include: unknown[] = Array.isArray(body.include) ? body.include : []
    if (!include.includes(REASONING_INCLUDE)) include.push(REASONING_INCLUDE)
    body.include = include
    const forcedStream = body.stream !== true
    body.stream = true
    return { init: { ...init, body: JSON.stringify(body) }, forcedStream }
  } catch {
    return { init, forcedStream: false }
  }
}

async function collapseSseToJson(res: Response): Promise<Response> {
  const text = await res.text()
  const items: unknown[] = []
  let failure: string | null = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const evt = JSON.parse(payload)
      if (evt.type === 'response.output_item.done' && evt.item) {
        items.push(evt.item)
      } else if (evt.type === 'response.completed' || evt.type === 'response.incomplete') {
        const response = evt.response ?? {}
        if (!Array.isArray(response.output) || response.output.length === 0) {
          response.output = items
        }
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      } else if (evt.type === 'response.failed' || evt.type === 'error') {
        failure = payload
      }
    } catch {
      // non-JSON data line — skip
    }
  }
  return new Response(failure ?? JSON.stringify({ error: 'SSE 流里没有 response.completed 事件' }), {
    status: 502,
    headers: { 'content-type': 'application/json' }
  })
}

/**
 * Builds the fetch to hand to `createOpenAI({ fetch })`. `getTokens` is
 * called per request and must return valid (auto-refreshed) tokens — see
 * createCodexTokenSource.
 */
export function createCodexFetch(
  getTokens: () => Promise<CodexTokens>,
  innerFetch: FetchLike = fetch
): FetchLike {
  return async (input, init) => {
    const tokens = await getTokens()
    const src = input instanceof URL ? input : new URL(input)
    const shouldRewrite =
      src.pathname.includes('/v1/responses') || src.pathname.includes('/chat/completions')
    const url = shouldRewrite ? CODEX_API_ENDPOINT : src
    const adapted = shouldRewrite ? adaptCodexBody(init) : { init, forcedStream: false }

    const headers = new Headers(adapted.init?.headers)
    headers.delete('authorization')
    headers.set('authorization', `Bearer ${tokens.accessToken}`)
    headers.set('originator', 'opencode')
    headers.set('User-Agent', USER_AGENT)
    if (tokens.accountId) headers.set('ChatGPT-Account-Id', tokens.accountId)

    const res = await innerFetch(url, { ...adapted.init, headers })
    if (res.ok && adapted.forcedStream) return collapseSseToJson(res)
    return res
  }
}
