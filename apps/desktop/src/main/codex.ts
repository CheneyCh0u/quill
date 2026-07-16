import { safeStorage, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  CODEX_PROVIDER_ID,
  createCodexTokenSource,
  defaultOpencodeAuthPath,
  listSupportedProviders,
  pollCodexDeviceAuth,
  readOpencodeAuth,
  startCodexDeviceAuth,
  type CodexAuthStore,
  type CodexTokens,
  type DeviceAuthPending
} from '@quill/agent'
import { listProviders, removeProvider, writeProviderMeta } from './providers'

/**
 * ChatGPT 订阅登录的桌面端宿主层：token 用 safeStorage 加密存
 * ~/.quill/providers/openai-codex.oauth.enc；设备码流程 / 刷新 / opencode
 * 解析等逻辑都在 @quill/agent，这里只做存储与编排。
 *
 * 登录后写入标准 provider meta（openai-codex.json），复用现有的
 * listProviders / 默认 provider / 模型选择链路。
 */

const TOKENS_FILE = join(homedir(), '.quill', 'providers', 'openai-codex.oauth.enc')

const store: CodexAuthStore = {
  async load() {
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      const buf = await fs.readFile(TOKENS_FILE)
      return JSON.parse(safeStorage.decryptString(buf)) as CodexTokens
    } catch {
      return null
    }
  },
  async save(tokens) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage 不可用（系统 keychain 未就绪），拒绝以明文存储登录凭证')
    }
    await fs.mkdir(dirname(TOKENS_FILE), { recursive: true })
    await fs.writeFile(TOKENS_FILE, safeStorage.encryptString(JSON.stringify(tokens)))
  },
  async clear() {
    await fs.unlink(TOKENS_FILE).catch(() => {})
  }
}

const tokenSource = createCodexTokenSource(store)

/**
 * CredentialProvider.getCodexTokens implementation — null when not logged
 * in; otherwise valid tokens (refreshed + persisted when near expiry).
 */
export async function getCodexTokensForAgent(): Promise<CodexTokens | null> {
  if (!(await store.load())) return null
  return tokenSource()
}

async function connect(tokens: CodexTokens): Promise<void> {
  await store.save(tokens)
  // Keep the user's previous model choice on re-login; default otherwise.
  const existing = (await listProviders()).find((m) => m.id === CODEX_PROVIDER_ID)
  const profile = listSupportedProviders().find((p) => p.id === CODEX_PROVIDER_ID)
  await writeProviderMeta(CODEX_PROVIDER_ID, existing?.model ?? profile?.defaultModelId ?? '')
}

export async function codexStatus(): Promise<{ connected: boolean; accountId: string | null }> {
  const tokens = await store.load()
  return { connected: tokens !== null, accountId: tokens?.accountId ?? null }
}

let pending: DeviceAuthPending | null = null

export async function codexLoginStart(): Promise<DeviceAuthPending> {
  pending = await startCodexDeviceAuth()
  // Fire-and-forget: the dialog also shows the URL, so a failed browser
  // launch isn't fatal.
  void shell.openExternal(pending.verificationUrl)
  return pending
}

export async function codexLoginPoll(): Promise<
  { status: 'pending' } | { status: 'connected'; accountId: string | null }
> {
  if (!pending) throw new Error('没有进行中的 ChatGPT 登录流程')
  const result = await pollCodexDeviceAuth(pending)
  if (result.status === 'pending') return { status: 'pending' }
  pending = null
  await connect(result.tokens)
  return { status: 'connected', accountId: result.tokens.accountId }
}

export function codexLoginCancel(): void {
  pending = null
}

export async function codexDetectOpencode(): Promise<{ found: boolean; path: string }> {
  const path = defaultOpencodeAuthPath()
  return { found: (await readOpencodeAuth(path)) !== null, path }
}

export async function codexImportOpencode(): Promise<{ accountId: string | null }> {
  const tokens = await readOpencodeAuth()
  if (!tokens) {
    throw new Error(`opencode 凭证里没有可用的 OpenAI 登录（${defaultOpencodeAuthPath()}）`)
  }
  await connect(tokens)
  return { accountId: tokens.accountId }
}

export async function codexLogout(): Promise<void> {
  pending = null
  await store.clear()
  await removeProvider(CODEX_PROVIDER_ID)
}
