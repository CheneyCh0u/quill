import { getProviderProfile } from './providers'

/**
 * Cross-cut of "providers the user has configured" × "models in the catalog
 * for those providers" — the universe of (provider, model) pairs the
 * in-chat picker shows for Plan and Build selection.
 *
 * Pure helper. The caller passes whatever `ipc.providers.list()` returned
 * so this stays testable without the IPC stub.
 */

export type AvailableModel = {
  providerId: string
  providerName: string
  modelId: string
  contextTokens: number
}

type StoredProviderMeta = {
  id: string
  model: string
  addedAt: number
  updatedAt: number
}

export function buildAvailableModels(configured: StoredProviderMeta[]): AvailableModel[] {
  const out: AvailableModel[] = []
  for (const cfg of configured) {
    const profile = getProviderProfile(cfg.id)
    if (!profile) continue // unknown provider id — defensive
    if (profile.models.length === 0) continue // catalog not yet populated
    for (const m of profile.models) {
      out.push({
        providerId: profile.id,
        providerName: profile.name,
        modelId: m.id,
        contextTokens: m.contextTokens
      })
    }
  }
  return out
}

export type ModelChoice = { providerId: string; modelId: string }

/**
 * Serialize as `<providerId>/<modelId>` for compact localStorage values
 * and dropdown <option value=...>. Splits on the FIRST `/` only so model
 * ids that themselves contain a slash survive the roundtrip.
 */
export function serializeModelChoice(choice: ModelChoice): string {
  return `${choice.providerId}/${choice.modelId}`
}

export function parseModelChoice(raw: string): ModelChoice | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) return null
  return {
    providerId: raw.slice(0, slash),
    modelId: raw.slice(slash + 1)
  }
}
