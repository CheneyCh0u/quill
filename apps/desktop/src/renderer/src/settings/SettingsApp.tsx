import { useState } from 'react'
import { ThemeProvider } from '../state/theme'
import { PrefsProvider } from '../state/prefs'
import { GeneralPanel } from './panels/GeneralPanel'
import { HelpPanel } from './panels/HelpPanel'
import { ProvidersPanel } from './panels/ProvidersPanel'
import { RemotePanel } from './panels/RemotePanel'

type SectionId = 'general' | 'providers' | 'remote' | 'help'

type Section = {
  id: SectionId
  label: string
  hint: string
}

const SECTIONS: Section[] = [
  { id: 'general', label: '通用', hint: 'general' },
  { id: 'providers', label: '大模型供应商', hint: 'AI providers' },
  { id: 'remote', label: '远程', hint: 'remote vault' },
  { id: 'help', label: '帮助', hint: 'help · about' }
]

function SettingsShell() {
  const [active, setActive] = useState<SectionId>('general')

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--paper)] text-[var(--ink)] overflow-hidden">
      {/* Drag region (hiddenInset on macOS) */}
      <div
        className="h-7 shrink-0 bg-[var(--paper-dim)] border-b border-[var(--rule)]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />

      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        <nav className="w-[180px] shrink-0 border-r border-[var(--rule)] bg-[var(--paper-dim)] flex flex-col py-3 px-2">
          <p className="font-display italic text-[12px] text-[var(--ink-faint)] px-3 py-1 mb-1 select-none">
            设置 / Settings
          </p>
          <ul className="space-y-0.5">
            {SECTIONS.map((s) => {
              const isActive = active === s.id
              return (
                <li key={s.id}>
                  <button
                    onClick={() => setActive(s.id)}
                    className={`no-drag w-full text-left px-3 py-1.5 rounded-md transition flex flex-col gap-0.5 ${
                      isActive
                        ? 'bg-[var(--paper-soft)] text-[var(--ink)]'
                        : 'text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]'
                    }`}
                    style={
                      isActive ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined
                    }
                  >
                    <span className="text-[13.5px] font-medium">{s.label}</span>
                    <span className="font-display italic text-[11px] text-[var(--ink-faint)]">
                      {s.hint}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        {/* Content */}
        <main className="flex-1 overflow-auto px-10 py-8 min-w-0">
          {active === 'general' && <GeneralPanel />}
          {active === 'providers' && <ProvidersPanel />}
          {active === 'remote' && <RemotePanel />}
          {active === 'help' && <HelpPanel />}
        </main>
      </div>
    </div>
  )
}

export default function SettingsApp() {
  return (
    <ThemeProvider>
      <PrefsProvider>
        <SettingsShell />
      </PrefsProvider>
    </ThemeProvider>
  )
}
