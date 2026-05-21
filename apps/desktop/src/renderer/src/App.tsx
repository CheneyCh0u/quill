import { useEffect } from 'react'
import { AppProvider, useApp } from './state/app'
import { ThemeProvider } from './state/theme'
import { PrefsProvider } from './state/prefs'
import { Sidebar } from './components/Sidebar'
import { RightPane } from './components/RightPane'
import { EmptyState } from './components/EmptyState'
import { StatusBar } from './components/StatusBar'
import { DragOverlay } from './components/DragOverlay'

function Shell() {
  const { state, mode, save } = useApp()

  // Cmd+S to save (in renderer; menu also fires this)
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [save])

  return (
    <div className="relative h-screen w-screen flex flex-col bg-[var(--paper)] text-[var(--ink)] overflow-hidden">
      <div
        className="h-7 shrink-0 border-b border-[var(--rule)] bg-[var(--paper-dim)]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />

      <div className="flex-1 flex min-h-0">
        {mode === 'empty' && <EmptyState />}
        {mode === 'workspace' && !state.sidebarCollapsed && <Sidebar />}
        {(mode === 'workspace' || mode === 'single') && <RightPane />}
      </div>

      <StatusBar />
      <DragOverlay />
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <PrefsProvider>
        <AppProvider>
          <Shell />
        </AppProvider>
      </PrefsProvider>
    </ThemeProvider>
  )
}
