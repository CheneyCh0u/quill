import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { CredentialProvider } from './credentials'
import { createCodexFetch } from './codex-fetch'

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'openai-codex'

export type ProviderModel = {
  /** Exact API model id passed to the provider's SDK. */
  id: string
  /** Total context window in tokens. The web/desktop UI uses this to:
   *  - render "(262K)" beside the model name in settings
   *  - detect when auto-compression should kick in before the next turn
   *  Set to 0 for providers/models where the window isn't known. */
  contextTokens: number
  /** Optional display label — falls back to `id` when omitted. */
  label?: string
}

export type ProviderProfile = {
  id: string
  kind: ProviderKind
  baseURL: string
  /** Preset model catalog. Empty array = provider isn't yet open to users
   *  (no models in the catalog). */
  models: ProviderModel[]
  /** Default model id to snap stored configs to when their stored model
   *  no longer appears in `models` (e.g. renames, removals). Empty string
   *  when the provider has no models yet. */
  defaultModelId: string
}

const KIMI_262K = 262_144
// GPT-5 系列输入上限（总窗口 400K = 272K 输入 + 128K 输出）；压缩阈值
// 按输入侧算。
const GPT5_272K = 272_000

/**
 * Minimal mirror of `renderer/src/lib/providers.ts` PROVIDERS. Keep in sync
 * with the renderer registry; renderer is the source of truth for display
 * name / docs URL. This module owns just the data required to (a) build
 * an ai-sdk model, (b) migrate stored configs with stale model ids, and
 * (c) hand a sanitized catalog to web clients via the server.
 */
export const PROFILES: Record<string, ProviderProfile> = {
  anthropic: {
    id: 'anthropic',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    models: [],
    defaultModelId: ''
  },
  openai: {
    id: 'openai',
    kind: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    models: [],
    defaultModelId: ''
  },
  // ChatGPT 订阅（OAuth 登录，非 API key）。baseURL 仍写标准 OpenAI 地址：
  // AI SDK 往这里发请求，createCodexFetch 在传输层改写到
  // chatgpt.com/backend-api/codex/responses 并注入订阅鉴权。
  'openai-codex': {
    id: 'openai-codex',
    kind: 'openai-codex',
    baseURL: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-5.5', contextTokens: GPT5_272K, label: 'GPT-5.5' },
      { id: 'gpt-5.5-codex', contextTokens: GPT5_272K, label: 'GPT-5.5 Codex' }
    ],
    defaultModelId: 'gpt-5.5'
  },
  // Kimi Coding Plan endpoint speaks the Anthropic protocol and allowlists
  // clients by SDK shape — OpenAI-compatible calls are rejected with
  // "Kimi For Coding is currently only available for Coding Agents…".
  kimi: {
    id: 'kimi',
    kind: 'anthropic',
    baseURL: 'https://api.kimi.com/coding/v1',
    models: [
      { id: 'kimi-k2-thinking', contextTokens: KIMI_262K },
      { id: 'k2p6', contextTokens: KIMI_262K },
      { id: 'k2p5', contextTokens: KIMI_262K },
      { id: 'kimi-k2.5', contextTokens: KIMI_262K }
    ],
    defaultModelId: 'kimi-k2-thinking'
  },
  deepseek: {
    id: 'deepseek',
    kind: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    models: [],
    defaultModelId: ''
  },
  glm: {
    id: 'glm',
    kind: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    models: [],
    defaultModelId: ''
  },
  qwen: {
    id: 'qwen',
    kind: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [],
    defaultModelId: ''
  }
}

/** Public catalog of supported providers. Server filters this to only
 *  those with at least one model before exposing it. */
export function listSupportedProviders(): ProviderProfile[] {
  return Object.values(PROFILES)
}

/**
 * Returns the preset model id a stored config should be snapped to when
 * its current `model` is no longer in the catalog, or null when no
 * migration is needed (model still valid or provider has no catalog yet).
 */
export function migrateModelId(providerId: string, storedModel: string): string | null {
  const profile = PROFILES[providerId]
  if (!profile || profile.models.length === 0) return null
  if (profile.models.some((m) => m.id === storedModel)) return null
  return profile.defaultModelId
}

/**
 * Build an ai-sdk LanguageModel for the given providerId + modelId. Resolves
 * the stored API key via the injected CredentialProvider so this module
 * stays portable across desktop (electron safeStorage) and server (config
 * file) deployments.
 */
export async function makeModel(
  providerId: string,
  modelId: string,
  credentials: CredentialProvider
): Promise<LanguageModel> {
  const profile = PROFILES[providerId]
  if (!profile) {
    throw new Error(`unknown provider: ${providerId}`)
  }
  if (profile.kind === 'openai-codex') {
    // Subscription login, no API key. The host supplies auto-refreshed
    // oauth tokens; the dummy apiKey only satisfies the SDK constructor —
    // real auth is injected per-request by createCodexFetch.
    const getCodexTokens = credentials.getCodexTokens?.bind(credentials)
    if (!getCodexTokens) {
      throw new Error(`provider "${providerId}" 需要 ChatGPT 订阅登录，当前环境不支持`)
    }
    const codexFetch = createCodexFetch(async () => {
      const tokens = await getCodexTokens(providerId)
      if (!tokens) {
        throw new Error('ChatGPT 订阅未登录 — 在设置 → 大模型供应商里登录 OpenAI')
      }
      return tokens
    })
    const openai = createOpenAI({
      apiKey: 'chatgpt-subscription',
      baseURL: profile.baseURL,
      // FetchLike matches the standard fetch call signature; Bun's fetch
      // type additionally declares `preconnect`, hence the cast.
      fetch: codexFetch as typeof fetch
    })
    return openai.responses(modelId)
  }
  const key = await credentials.getKey(providerId)
  if (!key) {
    throw new Error(`provider "${providerId}" not configured — set API key in Settings`)
  }
  if (profile.kind === 'anthropic') {
    // Pass baseURL explicitly so providers piggybacking on the Anthropic
    // protocol (Kimi Coding Plan, etc.) hit their own host. For real
    // Anthropic the URL matches the SDK default and is a no-op.
    const anthropic = createAnthropic({ apiKey: key, baseURL: profile.baseURL })
    return anthropic(modelId)
  }
  const provider = createOpenAICompatible({
    name: providerId,
    baseURL: profile.baseURL,
    apiKey: key
  })
  return provider(modelId)
}
