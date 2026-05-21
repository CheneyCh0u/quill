import { Sun, Moon, Monitor } from 'lucide-react'
import { useTheme } from '../state/theme'

export function ThemeToggle() {
  const { pref, cyclePref } = useTheme()
  const Icon = pref === 'light' ? Sun : pref === 'dark' ? Moon : Monitor
  const label = pref === 'light' ? '浅色' : pref === 'dark' ? '深色' : '跟随系统'

  return (
    <button
      onClick={cyclePref}
      title={`主题：${label}（点击切换）`}
      className="no-drag flex items-center gap-1.5 px-2 py-0.5 rounded-md hover:bg-[var(--paper-soft)] text-[var(--ink-faint)] hover:text-[var(--ink)] transition"
    >
      <Icon className="w-3 h-3" />
      <span className="font-serif-zh italic text-[11px]">{label}</span>
    </button>
  )
}
