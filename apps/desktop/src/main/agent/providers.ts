import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { getProviderKey } from '../providers'

type ProviderKind = 'anthropic' | 'openai-compatible'

type ProviderProfile = {
  kind: ProviderKind
  baseURL: string
  /** Preset model ids the renderer dropdown offers. Empty array = provider
   *  isn't yet open to users (no models in the catalog). */
  models: string[]
  /** Default model id to snap stored configs to when their stored model
   *  no longer appears in `models` (e.g. renames, removals). Empty string
   *  when the provider has no models yet. */
  defaultModelId: string
}

/**
 * Minimal mirror of `renderer/src/lib/providers.ts` PROVIDERS. Keep in sync
 * with the renderer registry; renderer is the source of truth for display
 * name / docs URL / context window sizes. Main only needs the data required
 * to (a) build an ai-sdk model and (b) migrate stored configs with stale
 * model ids.
 */
const PROFILES: Record<string, ProviderProfile> = {
  anthropic: { kind: 'anthropic', baseURL: 'https://api.anthropic.com', models: [], defaultModelId: '' },
  openai: {
    kind: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    models: [],
    defaultModelId: ''
  },
  // Kimi Coding Plan endpoint speaks the Anthropic protocol and allowlists
  // clients by SDK shape — OpenAI-compatible calls are rejected with
  // "Kimi For Coding is currently only available for Coding Agents…".
  kimi: {
    kind: 'anthropic',
    baseURL: 'https://api.kimi.com/coding/v1',
    models: ['kimi-k2-thinking', 'k2p6', 'k2p5', 'kimi-k2.5'],
    defaultModelId: 'kimi-k2-thinking'
  },
  deepseek: {
    kind: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    models: [],
    defaultModelId: ''
  },
  glm: {
    kind: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    models: [],
    defaultModelId: ''
  },
  qwen: {
    kind: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [],
    defaultModelId: ''
  }
}

/**
 * Returns the preset model id a stored config should be snapped to when
 * its current `model` is no longer in the catalog, or null when no
 * migration is needed (model still valid or provider has no catalog yet).
 */
export function migrateModelId(providerId: string, storedModel: string): string | null {
  const profile = PROFILES[providerId]
  if (!profile || profile.models.length === 0) return null
  if (profile.models.includes(storedModel)) return null
  return profile.defaultModelId
}

/**
 * Build an ai-sdk LanguageModel for the given providerId + modelId. Decrypts
 * the stored API key on demand — main process only.
 */
export async function makeModel(
  providerId: string,
  modelId: string
): Promise<LanguageModel> {
  const profile = PROFILES[providerId]
  if (!profile) {
    throw new Error(`unknown provider: ${providerId}`)
  }
  const key = await getProviderKey(providerId)
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
