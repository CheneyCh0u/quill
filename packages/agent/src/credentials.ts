/**
 * Strategy for resolving an API key for a given provider id at LLM-call time.
 *
 * Implementations:
 * - Desktop: wraps `getProviderKey` (electron safeStorage / keychain).
 * - Server:  reads from `config.yaml` providers list (decrypted at startup).
 *
 * Returning `null` indicates the provider isn't configured — `makeModel`
 * surfaces that as a user-actionable error ("set API key in Settings").
 */
import type { CodexTokens } from './codex-auth'

export interface CredentialProvider {
  getKey(providerId: string): Promise<string | null>
  /**
   * Valid (auto-refreshed) ChatGPT subscription tokens for oauth-kind
   * providers. Optional — hosts without subscription login support (e.g.
   * the server today) simply omit it and `makeModel` raises a clear error.
   * Returning `null` means the user hasn't logged in yet.
   */
  getCodexTokens?(providerId: string): Promise<CodexTokens | null>
}
