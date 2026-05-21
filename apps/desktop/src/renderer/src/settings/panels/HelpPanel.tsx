import { useEffect, useState } from 'react'
import { ipc } from '../../lib/ipc'

export function HelpPanel() {
  const [version, setVersion] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    void ipc.getAppVersion().then(setVersion)
  }, [])

  const onCheckUpdate = (): void => {
    setToast('暂未实现 — 自动更新会在 v0.2 上线')
    window.setTimeout(() => setToast(null), 2400)
  }

  return (
    <div className="max-w-[520px]">
      <h2 className="font-display text-[28px] text-[var(--ink)] mb-1" style={{ fontWeight: 500 }}>
        帮助
      </h2>
      <p className="font-serif-zh italic text-[13px] text-[var(--ink-faint)] mb-8">
        关于 / about
      </p>

      <div className="flex items-start gap-6">
        <div className="w-16 h-16 rounded-[14px] bg-[var(--paper-soft)] flex items-center justify-center shrink-0">
          <span
            className="font-display text-[32px] text-[var(--accent)]"
            style={{ fontWeight: 500, fontVariationSettings: '"SOFT" 80, "WONK" 1' }}
          >
            Q
          </span>
        </div>

        <div className="flex-1">
          <div className="font-display text-[24px] text-[var(--ink)]" style={{ fontWeight: 500 }}>
            Quill
          </div>
          <div className="font-serif-zh italic text-[13px] text-[var(--ink-soft)] mt-1">
            一个安静的 markdown 编辑器
          </div>

          <div className="mt-5 inline-flex items-center gap-2 text-[12px] font-mono text-[var(--ink-soft)] bg-[var(--paper-soft)] rounded-md px-2.5 py-1">
            <span className="text-[var(--ink-faint)]">version</span>
            <span className="text-[var(--ink)]">{version ?? '…'}</span>
          </div>

          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={onCheckUpdate}
              className="no-drag px-4 py-1.5 rounded-md bg-[var(--accent)] text-[var(--paper)] text-[13px] font-medium hover:opacity-90 transition active:scale-[0.98]"
            >
              检查更新
            </button>
            {toast && (
              <span className="font-serif-zh italic text-[12px] text-[var(--ink-faint)]">
                {toast}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-10 pt-6 border-t border-[var(--rule-soft)]">
        <p className="font-serif-zh italic text-[12.5px] text-[var(--ink-faint)] leading-[1.8]">
          Quill is built with Electron + React + Tailwind v4, using CodeMirror 6 for
          editing and markdown-it for preview. Designed and written with care for a
          quiet writing surface.
        </p>
      </div>
    </div>
  )
}
