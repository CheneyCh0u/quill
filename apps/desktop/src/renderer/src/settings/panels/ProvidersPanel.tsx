import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ExternalLink, Loader2, Trash2 } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import {
  PROVIDERS,
  validateProviderConfig,
  type ProviderProfile,
  type ProviderId
} from '../../lib/providers'

/** Compact context display: 262144 → "262K", 1_000_000 → "1.0M". */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + 'M'
  return Math.round(tokens / 1000) + 'K'
}

type StoredMeta = {
  id: string
  model: string
  addedAt: number
  updatedAt: number
}

type ModalState = {
  provider: ProviderProfile
  /** True when editing an already-configured provider. */
  existing: boolean
}

export function ProvidersPanel() {
  const [configured, setConfigured] = useState<StoredMeta[]>([])
  const [defaultId, setDefaultId] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalState | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    const [list, def] = await Promise.all([
      ipc.providers.list(),
      ipc.providers.getDefault()
    ])
    setConfigured(list)
    setDefaultId(def)
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const configuredMap = new Map(configured.map((c) => [c.id, c]))
  // Hide providers with no curated models — they're stubs waiting for
  // their model tables to be filled in. Avoids showing dead entries.
  const visibleProviders = useMemo(
    () => PROVIDERS.filter((p) => p.models.length > 0),
    []
  )

  return (
    <div className="max-w-[640px]">
      <h2
        className="font-display text-[28px] text-[var(--ink)] mb-1"
        style={{ fontWeight: 500 }}
      >
        大模型供应商
      </h2>
      <p className="font-serif-zh italic text-[13px] text-[var(--ink-faint)] mb-6">
        AI Providers · 配置 API key 后即可在 agent 中使用
      </p>

      {loading ? (
        <div className="text-[var(--ink-faint)] text-sm">加载中…</div>
      ) : (
        <ul className="space-y-1">
          {visibleProviders.length === 0 && (
            <li className="font-serif-zh italic text-[12px] text-[var(--ink-faint)] py-4">
              暂无可配置的 provider
            </li>
          )}
          {visibleProviders.map((p) => {
            const meta = configuredMap.get(p.id)
            const isDefault = defaultId === p.id
            return (
              <li
                key={p.id}
                className="flex items-center gap-3 py-3 px-3 rounded-md hover:bg-[var(--paper-dim)] transition group"
              >
                <input
                  type="radio"
                  name="default-provider"
                  checked={isDefault}
                  disabled={!meta}
                  onChange={() => void ipc.providers.setDefault(p.id).then(reload)}
                  title={meta ? '设为默认' : '配置后才能设为默认'}
                  className="accent-[var(--accent)] disabled:opacity-30"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-[var(--ink)]">
                      {p.name}
                    </span>
                    {meta && (
                      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--accent)] font-medium">
                        <Check className="w-3 h-3" />
                        已配置
                      </span>
                    )}
                    {isDefault && (
                      <span className="font-serif-zh italic text-[11px] text-[var(--accent)]">
                        默认
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[11px] text-[var(--ink-faint)] truncate mt-0.5">
                    {meta ? meta.model : `默认 ${p.defaultModelId}`} · {p.baseURL}
                  </div>
                </div>
                <button
                  onClick={() => setModal({ provider: p, existing: !!meta })}
                  className="no-drag px-3 py-1 rounded-md text-[12px] text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition"
                >
                  {meta ? '编辑' : '配置'}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <p className="font-serif-zh italic text-[12px] text-[var(--ink-faint)] mt-6 leading-[1.7]">
        API key 通过系统 keychain (macOS Keychain / Windows DPAPI) 加密存储在
        <span className="font-mono not-italic"> ~/.quill/providers/ </span>，
        不写入应用偏好设置。
      </p>

      {modal && (
        <ProviderModal
          provider={modal.provider}
          existingMeta={configuredMap.get(modal.provider.id)}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null)
            void reload()
          }}
          onRemoved={() => {
            setModal(null)
            void reload()
          }}
        />
      )}
    </div>
  )
}

type ModalProps = {
  provider: ProviderProfile
  existingMeta?: StoredMeta
  onClose: () => void
  onSaved: () => void
  onRemoved: () => void
}

function ProviderModal({
  provider,
  existingMeta,
  onClose,
  onSaved,
  onRemoved
}: ModalProps) {
  const editing = !!existingMeta
  const [key, setKey] = useState('')
  // If stored model isn't in the current preset list (legacy / removed),
  // snap to the provider's default so the dropdown has a valid selection.
  const initialModel =
    existingMeta?.model && provider.models.some((m) => m.id === existingMeta.model)
      ? existingMeta.model
      : provider.defaultModelId
  const [model, setModel] = useState(initialModel)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; status?: number; error?: string } | null>(
    null
  )

  const handleTest = useCallback(async () => {
    setBusy('test')
    setTestResult(null)
    try {
      const r = await ipc.providers.test(provider.baseURL)
      setTestResult(r)
    } finally {
      setBusy(null)
    }
  }, [provider.baseURL])

  const handleSave = useCallback(async () => {
    setError(null)
    const trimmedKey = key.trim()
    const trimmedModel = model.trim()

    if (trimmedModel.length === 0) {
      setError('Model 不能为空')
      return
    }

    // Editing + empty key field → just update model, keep stored key
    if (editing && trimmedKey.length === 0) {
      setBusy('save')
      try {
        await ipc.providers.updateModel({ id: provider.id, model: trimmedModel })
        onSaved()
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      } finally {
        setBusy(null)
      }
      return
    }

    // New entry OR editing with new key → full upsert
    const v = validateProviderConfig({ id: provider.id, key, model })
    if (!v.ok) {
      setError(v.error)
      return
    }
    setBusy('save')
    try {
      await ipc.providers.upsert({
        id: v.config.id,
        key: v.config.key,
        model: v.config.model
      })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(null)
    }
  }, [editing, key, model, provider.id, onSaved])

  const handleRemove = useCallback(async () => {
    if (!editing) return
    setBusy('remove')
    try {
      await ipc.providers.remove(provider.id as ProviderId)
      onRemoved()
    } finally {
      setBusy(null)
    }
  }, [editing, provider.id, onRemoved])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-[var(--ink)]/30 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[460px] rounded-[12px] bg-[var(--paper)] border border-[var(--rule)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[var(--rule)]">
          <h3
            className="font-display text-[18px] text-[var(--ink)]"
            style={{ fontWeight: 500 }}
          >
            {editing ? '编辑' : '配置'} {provider.name}
          </h3>
          {provider.docs && (
            <a
              href={provider.docs}
              onClick={(e) => {
                e.preventDefault()
                window.open(provider.docs, '_blank')
              }}
              className="inline-flex items-center gap-1 mt-1 text-[12px] text-[var(--accent)] hover:underline"
            >
              获取 API key <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>

        <div className="px-6 py-5 space-y-4">
          <Field label="Base URL">
            <input
              type="text"
              readOnly
              value={provider.baseURL}
              className="w-full px-3 py-1.5 rounded-md bg-[var(--paper-soft)] text-[13px] font-mono text-[var(--ink-soft)] border border-[var(--rule-soft)] focus:outline-none"
            />
          </Field>

          <Field
            label="API Key"
            hint={editing ? '留空则保留原 key' : undefined}
          >
            <input
              type="password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value)
                if (error) setError(null)
              }}
              placeholder={editing ? '••••••••（已加密存储）' : 'sk-...'}
              className="w-full px-3 py-1.5 rounded-md bg-[var(--paper)] text-[13px] font-mono text-[var(--ink)] border border-[var(--rule)] focus:outline-none focus:border-[var(--accent)]/50"
              autoFocus
            />
          </Field>

          <Field label="Model">
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value)
                if (error) setError(null)
              }}
              className="w-full px-3 py-1.5 rounded-md bg-[var(--paper)] text-[13px] font-mono text-[var(--ink)] border border-[var(--rule)] focus:outline-none focus:border-[var(--accent)]/50 cursor-pointer"
            >
              {provider.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label ?? m.id} · {formatContext(m.contextTokens)}
                </option>
              ))}
            </select>
          </Field>

          {error && (
            <div className="font-serif-zh italic text-[12px] text-[var(--accent)]">
              {error}
            </div>
          )}

          {testResult && !error && (
            <div
              className={`font-serif-zh italic text-[12px] ${
                testResult.ok ? 'text-[var(--ink-soft)]' : 'text-[var(--accent)]'
              }`}
            >
              {testResult.ok
                ? `连接 OK · HTTP ${testResult.status}`
                : `不可达：${testResult.error}`}
            </div>
          )}
        </div>

        <div className="px-6 py-4 bg-[var(--paper-dim)] border-t border-[var(--rule)] flex items-center gap-2">
          {editing && (
            <button
              onClick={handleRemove}
              disabled={busy !== null}
              className="no-drag flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] text-[var(--ink-faint)] hover:text-[var(--accent)] hover:bg-[var(--paper-soft)] transition disabled:opacity-40"
            >
              {busy === 'remove' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
              删除
            </button>
          )}

          <button
            onClick={handleTest}
            disabled={busy !== null}
            className="no-drag flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition disabled:opacity-40"
          >
            {busy === 'test' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : null}
            测试连接
          </button>

          <div className="flex-1" />

          <button
            onClick={onClose}
            disabled={busy !== null}
            className="no-drag px-3 py-1.5 rounded-md text-[12px] text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={busy !== null}
            className="no-drag px-4 py-1.5 rounded-md bg-[var(--accent)] text-[var(--paper)] text-[12.5px] font-medium hover:opacity-90 transition active:scale-[0.98] disabled:opacity-50"
          >
            {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

type FieldProps = {
  label: string
  hint?: string
  children: React.ReactNode
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label className="text-[12px] font-medium text-[var(--ink)]">{label}</label>
        {hint && (
          <span className="font-serif-zh italic text-[11px] text-[var(--ink-faint)]">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

