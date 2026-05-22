import { useEffect, useState } from 'react'
import { AppProvider, useApp } from './state/app'
import { ThemeProvider } from './state/theme'
import { PrefsProvider } from './state/prefs'
import { Sidebar } from './components/Sidebar'
import { RightPane } from './components/RightPane'
import { EmptyState } from './components/EmptyState'
import { StatusBar } from './components/StatusBar'
import { DragOverlay } from './components/DragOverlay'
import { AgentPanel } from './components/AgentPanel'
import { OpenChoiceDialog } from './components/OpenChoiceDialog'
import { ipc, switchToRemote } from './lib/ipc'

const AGENT_OPEN_KEY = 'quill.agent.open'

function readAgentOpen(): boolean {
  try {
    return window.localStorage.getItem(AGENT_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function Shell() {
  const { state, mode, save, openChoiceRequest, openRemoteAt } = useApp()
  const [agentOpen, setAgentOpen] = useState<boolean>(() => readAgentOpen())
  // Agent runs in the local main process with local fs tools — pointing
  // it at a remote vault would be confusing (writes would land on disk
  // here, not the server). Hide the panel + ignore the shortcut until
  // server-agent integration ships.
  const inRemote = state.workspace?.kind === 'remote'

  // On first launch in this session, try to restore a remote workspace
  // if the user previously connected. Validates the stored token against
  // /api/auth/me before opening — silently falls back to empty state on
  // 401 (token expired) or network error.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const url = await ipc.remote.getUrl()
      const token = await ipc.remote.getToken()
      if (!url || !token || cancelled) return
      try {
        const res = await fetch(`${url}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (!res.ok || cancelled) return
        switchToRemote({ url, getToken: () => ipc.remote.getToken() })
        await openRemoteAt(url)
      } catch {
        /* network failure — user can manually reconnect from empty state */
      }
    })()
    return () => {
      cancelled = true
    }
    // Intentionally run once on mount; openRemoteAt is stable from useCallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(AGENT_OPEN_KEY, agentOpen ? '1' : '0')
    } catch {
      /* localStorage may be disabled — best-effort persist only */
    }
  }, [agentOpen])

  // Cmd+S save, Cmd+J toggle agent panel
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void save()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault()
        if (inRemote) return
        setAgentOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [save, inRemote])

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
        {agentOpen && !inRemote && (
          <AgentPanel onClose={() => setAgentOpen(false)} />
        )}
      </div>

      <StatusBar
        agentOpen={agentOpen && !inRemote}
        onToggleAgent={inRemote ? undefined : () => setAgentOpen((v) => !v)}
      />
      <DragOverlay />
      {openChoiceRequest && (
        <OpenChoiceDialog
          request={openChoiceRequest}
          onResolve={openChoiceRequest.resolve}
        />
      )}
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
