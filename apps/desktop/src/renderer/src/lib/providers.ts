/**
 * Provider registry — hardcoded list of supported LLM providers and their
 * curated model catalogs. The settings UI renders an "add this provider"
 * affordance for each one with `models.length > 0`; the main process uses
 * `baseURL` + `kind` + the chosen model id to instantiate an ai-sdk model.
 *
 * Adding a model: append to the provider's `models[]` with its exact API
 * id and total context window. Adding a provider: extend ProviderId +
 * append a PROVIDERS entry — UI is generic, no other files need touching.
 */

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'openai-codex'
  | 'kimi'
  | 'deepseek'
  | 'glm'
  | 'qwen'

export type ProviderModel = {
  /** Exact API model id passed to the provider. */
  id: string
  /** Total context window in tokens. Used to detect when auto-compression
   *  should kick in and to surface "this model can fit X tokens" in the
   *  UI. */
  contextTokens: number
  /** Optional friendly label. Defaults to `id` when omitted. */
  label?: string
}

export type ProviderProfile = {
  id: ProviderId
  /** Display name shown in settings UI. */
  name: string
  /** API base URL. */
  baseURL: string
  /** Curated model catalog. Empty array = provider is hidden from the
   *  settings list until a real catalog is filled in. */
  models: ProviderModel[]
  /** Default model id pre-selected in the add modal. Must reference one
   *  of `models[]` when models is non-empty (asserted in tests). */
  defaultModelId: string
  /** ai-sdk provider factory to use. */
  kind: 'openai-compatible' | 'anthropic' | 'openai-codex'
  /** How the user authenticates. Defaults to 'api-key'; 'oauth' providers
   *  get a login flow instead of a key input in settings. */
  auth?: 'api-key' | 'oauth'
  /** Where to get an API key (shown as a help link in the add modal). */
  docs?: string
}

const KIMI_262K = 262_144
// GPT-5 系列输入上限（总窗口 400K = 272K 输入 + 128K 输出）。
const GPT5_272K = 272_000

export const PROVIDERS: ProviderProfile[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com',
    models: [],
    defaultModelId: '',
    kind: 'anthropic',
    docs: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: [],
    defaultModelId: '',
    kind: 'openai-compatible',
    docs: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'openai-codex',
    name: 'OpenAI (ChatGPT 订阅)',
    // AI SDK 请求这个地址，主进程的 codexFetch 在传输层改写到
    // ChatGPT 订阅端点（chatgpt.com/backend-api/codex/responses）。
    baseURL: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-5.5', contextTokens: GPT5_272K, label: 'GPT-5.5' },
      { id: 'gpt-5.5-codex', contextTokens: GPT5_272K, label: 'GPT-5.5 Codex' }
    ],
    defaultModelId: 'gpt-5.5',
    kind: 'openai-codex',
    auth: 'oauth'
  },
  {
    id: 'kimi',
    name: 'Kimi (Coding Plan)',
    baseURL: 'https://api.kimi.com/coding/v1',
    // 4 curated models, all 262K context per Coding Plan docs.
    models: [
      { id: 'kimi-k2-thinking', contextTokens: KIMI_262K },
      { id: 'k2p6', contextTokens: KIMI_262K },
      { id: 'k2p5', contextTokens: KIMI_262K },
      { id: 'kimi-k2.5', contextTokens: KIMI_262K }
    ],
    defaultModelId: 'kimi-k2-thinking',
    // Kimi Coding endpoint allowlists clients that speak the Anthropic
    // protocol; OpenAI-compatible calls return "only available for Coding
    // Agents such as Kimi CLI, Claude Code…".
    kind: 'anthropic',
    docs: 'https://platform.moonshot.cn/console/api-keys'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: [],
    defaultModelId: '',
    kind: 'openai-compatible',
    docs: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'glm',
    name: 'GLM (Zhipu)',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    models: [],
    defaultModelId: '',
    kind: 'openai-compatible',
    docs: 'https://open.bigmodel.cn/usercenter/apikeys'
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [],
    defaultModelId: '',
    kind: 'openai-compatible',
    docs: 'https://dashscope.console.aliyun.com/apiKey'
  }
]

const PROVIDER_INDEX = new Map(PROVIDERS.map((p) => [p.id, p]))

export function getProviderProfile(id: string): ProviderProfile | undefined {
  return PROVIDER_INDEX.get(id as ProviderId)
}

export function getProviderModel(
  providerId: string,
  modelId: string
): ProviderModel | undefined {
  return getProviderProfile(providerId)?.models.find((m) => m.id === modelId)
}

export function isKnownProvider(id: string): id is ProviderId {
  return PROVIDER_INDEX.has(id as ProviderId)
}

/**
 * A provider is "configurable" when it has at least one curated model.
 * Providers with empty `models[]` are intentionally hidden from settings
 * until their catalog is populated.
 */
export function isConfigurableProvider(id: string): boolean {
  const p = getProviderProfile(id)
  return !!p && p.models.length > 0
}

export type ProviderConfig = {
  id: ProviderId
  /** API key — raw secret as user typed it. */
  key: string
  /** Model id to use. Must be one of the provider's preset models. */
  model: string
}

export type ProviderConfigInput = {
  id: string
  key: string
  model: string
}

export type ValidationResult =
  | { ok: true; config: ProviderConfig }
  | { ok: false; error: string }

/**
 * Pure validator for user-entered provider config. Trims whitespace,
 * rejects empty / unknown values, and ensures the chosen model is in
 * the provider's curated catalog. Does NOT make any network calls.
 */
export function validateProviderConfig(input: ProviderConfigInput): ValidationResult {
  const profile = getProviderProfile(input.id)
  if (!profile) {
    return { ok: false, error: `未知 provider: ${input.id}` }
  }
  if (profile.auth === 'oauth') {
    return { ok: false, error: `${profile.name} 使用登录授权，不通过 API key 配置` }
  }
  if (profile.models.length === 0) {
    return {
      ok: false,
      error: `${profile.name} 暂未配置可用模型 (no models in catalog yet)`
    }
  }
  const key = input.key.trim()
  if (key.length === 0) {
    return { ok: false, error: 'API Key 不能为空' }
  }
  const model = input.model.trim()
  if (model.length === 0) {
    return { ok: false, error: 'Model 不能为空' }
  }
  if (!profile.models.some((m) => m.id === model)) {
    return {
      ok: false,
      error: `model "${model}" not in ${profile.name} 的预设列表`
    }
  }
  return { ok: true, config: { id: profile.id, key, model } }
}
