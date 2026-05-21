import { useTheme } from '../../state/theme'
import { usePrefs } from '../../state/prefs'
import type { ThemePref, ViewMode } from '../../types'

type RowProps = {
  label: string
  hint?: string
  children: React.ReactNode
}

function Row({ label, hint, children }: RowProps) {
  return (
    <div className="flex items-start py-4 border-b border-[var(--rule-soft)] last:border-b-0">
      <div className="w-[140px] shrink-0 pt-1">
        <div className="text-[13.5px] font-medium text-[var(--ink)]">{label}</div>
        {hint && (
          <div className="font-serif-zh italic text-[12px] text-[var(--ink-faint)] mt-0.5">
            {hint}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

type PillProps<T extends string | number> = {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
}

function PillGroup<T extends string | number>({ options, value, onChange }: PillProps<T>) {
  return (
    <div className="inline-flex items-center gap-0.5 p-0.5 rounded-full bg-[var(--paper-soft)]">
      {options.map((opt) => {
        const isActive = opt.value === value
        return (
          <button
            key={String(opt.value)}
            onClick={() => onChange(opt.value)}
            className={`px-3.5 py-1 rounded-full text-[12.5px] transition ${
              isActive
                ? 'bg-[var(--ink)] text-[var(--paper)] font-medium'
                : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

type ToggleProps = {
  checked: boolean
  onChange: (v: boolean) => void
}

function Toggle({ checked, onChange }: ToggleProps) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex items-center w-10 h-5 rounded-full transition ${
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--paper-soft)] border border-[var(--rule)]'
      }`}
      aria-pressed={checked}
    >
      <span
        className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-[var(--paper)] shadow transition-transform ${
          checked ? 'translate-x-[22px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  )
}

const THEME_OPTIONS: Array<{ value: ThemePref; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' }
]

const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16].map((n) => ({ value: n, label: String(n) }))

const VIEW_MODE_OPTIONS: Array<{ value: ViewMode; label: string }> = [
  { value: 'edit', label: '编辑' },
  { value: 'split', label: '分栏' },
  { value: 'preview', label: '预览' }
]

export function GeneralPanel() {
  const { pref, setPref } = useTheme()
  const { prefs, setPref: setEditorPref } = usePrefs()

  return (
    <div className="max-w-[520px]">
      <h2 className="font-display text-[28px] text-[var(--ink)] mb-1" style={{ fontWeight: 500 }}>
        通用
      </h2>
      <p className="font-serif-zh italic text-[13px] text-[var(--ink-faint)] mb-6">
        外观与编辑器
      </p>

      <Row label="主题" hint="跟随系统会同步 macOS 的浅 / 深色设置">
        <PillGroup options={THEME_OPTIONS} value={pref} onChange={setPref} />
      </Row>

      <Row label="编辑器字号" hint="影响 markdown 源码编辑器的字号">
        <PillGroup
          options={FONT_SIZE_OPTIONS}
          value={prefs.fontSize}
          onChange={(v) => setEditorPref('fontSize', v)}
        />
      </Row>

      <Row label="默认视图" hint="打开文件 / 新建文件时的初始模式">
        <PillGroup
          options={VIEW_MODE_OPTIONS}
          value={prefs.defaultViewMode}
          onChange={(v) => setEditorPref('defaultViewMode', v)}
        />
      </Row>

      <Row label="显示行号" hint="CodeMirror 的左侧行号 gutter">
        <Toggle
          checked={prefs.showLineNumbers}
          onChange={(v) => setEditorPref('showLineNumbers', v)}
        />
      </Row>
    </div>
  )
}
