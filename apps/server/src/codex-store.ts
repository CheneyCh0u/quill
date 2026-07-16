import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { CodexAuthStore, CodexTokens } from '@quill/agent'

/**
 * Server-side persistence for the ChatGPT subscription login. JSON at
 * `path` (chmod 0600, same protection model as providers.json), holding
 * the OAuth tokens plus the user's chosen model — the model lives here
 * rather than in ProvidersStore because the codex provider has no api_key
 * entry there.
 *
 * In-memory cache backs reads so token refresh (which hits load() on
 * every LLM call) doesn't re-read the file each time.
 */

type FileShape = {
  tokens: CodexTokens | null
  model: string
}

export class ServerCodexStore implements CodexAuthStore {
  private cache: FileShape | null = null

  constructor(private readonly path: string) {}

  private async read(): Promise<FileShape> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as Partial<FileShape>
      this.cache = {
        tokens: parsed.tokens ?? null,
        model: typeof parsed.model === 'string' ? parsed.model : ''
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.cache = { tokens: null, model: '' }
    }
    return this.cache
  }

  private async write(next: FileShape): Promise<void> {
    this.cache = next
    await fs.mkdir(dirname(this.path), { recursive: true })
    await fs.writeFile(this.path, JSON.stringify(next, null, 2), { mode: 0o600 })
    // writeFile's mode only applies on create — enforce on overwrite too.
    await fs.chmod(this.path, 0o600)
  }

  async load(): Promise<CodexTokens | null> {
    return (await this.read()).tokens
  }

  async save(tokens: CodexTokens): Promise<void> {
    await this.write({ ...(await this.read()), tokens })
  }

  async clear(): Promise<void> {
    await this.write({ ...(await this.read()), tokens: null })
  }

  async getModel(): Promise<string> {
    return (await this.read()).model
  }

  async setModel(model: string): Promise<void> {
    await this.write({ ...(await this.read()), model })
  }
}
