/**
 * Provider registry — hardcoded list of supported LLM providers. Each entry
 * is enough for the settings UI to render an "add this provider" affordance
 * and for the main process to (eventually) instantiate an ai-sdk model.
 *
 * To add a new provider, append an entry here. UI is generic, no other
 * files need touching.
 */

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'kimi'
  | 'deepseek'
  | 'glm'
  | 'qwen'

export type ProviderProfile = {
  id: ProviderId
  /** Display name shown in settings UI. */
  name: string
  /** API base URL. OpenAI-compatible endpoint preferred when the provider
   *  offers both (e.g. Kimi). */
  baseURL: string
  /** Default model id to pre-fill when adding. */
  defaultModel: string
  /** ai-sdk provider factory to use. v1 supports two: 'openai-compatible'
   *  (most providers) and 'anthropic' (Claude native). */
  kind: 'openai-compatible' | 'anthropic'
  /** Where to get an API key (shown as a help link in the add modal). */
  docs?: string
}

export const PROVIDERS: ProviderProfile[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
    kind: 'anthropic',
    docs: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    kind: 'openai-compatible',
    docs: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'kimi',
    name: 'Kimi (Coding Plan)',
    baseURL: 'https://api.kimi.com/coding/v1',
    defaultModel: 'kimi-for-coding',
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
    defaultModel: 'deepseek-chat',
    kind: 'openai-compatible',
    docs: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'glm',
    name: 'GLM (Zhipu)',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    defaultModel: 'glm-4.6',
    kind: 'openai-compatible',
    docs: 'https://open.bigmodel.cn/usercenter/apikeys'
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    kind: 'openai-compatible',
    docs: 'https://dashscope.console.aliyun.com/apiKey'
  }
]

const PROVIDER_INDEX = new Map(PROVIDERS.map((p) => [p.id, p]))

export function getProviderProfile(id: string): ProviderProfile | undefined {
  return PROVIDER_INDEX.get(id as ProviderId)
}

export function isKnownProvider(id: string): id is ProviderId {
  return PROVIDER_INDEX.has(id as ProviderId)
}

export type ProviderConfig = {
  id: ProviderId
  /** API key — raw secret as user typed it. */
  key: string
  /** Model id to use. May differ from profile.defaultModel. */
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
 * Pure validator for user-entered provider config. Trims whitespace and
 * rejects empty / unknown values. Does NOT make any network calls.
 */
export function validateProviderConfig(input: ProviderConfigInput): ValidationResult {
  if (!isKnownProvider(input.id)) {
    return { ok: false, error: `未知 provider: ${input.id}` }
  }
  const key = input.key.trim()
  if (key.length === 0) {
    return { ok: false, error: 'API Key 不能为空' }
  }
  const model = input.model.trim()
  if (model.length === 0) {
    return { ok: false, error: 'Model 不能为空' }
  }
  return { ok: true, config: { id: input.id, key, model } }
}
