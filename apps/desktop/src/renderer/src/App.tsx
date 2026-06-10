import { useCallback, useEffect, useState } from 'react'
import { AppProvider, useApp } from './state/app'
import { ThemeProvider } from './state/theme'
import { PrefsProvider } from './state/prefs'
import { SyncProvider } from './state/sync'
import { Sidebar } from './components/Sidebar'
import { RightPane } from './components/RightPane'
import { EmptyState } from './components/EmptyState'
import { StatusBar } from './components/StatusBar'
import { DragOverlay } from './components/DragOverlay'
import { AgentPanel } from './components/AgentPanel'
import { OpenChoiceDialog } from './components/OpenChoiceDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { RemoteLoginDialog } from './components/RemoteLoginDialog'
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
  const { state, mode, save, openChoiceRequest, confirmRequest, openRemoteAt, exitRemote } =
    useApp()
  const [agentOpen, setAgentOpen] = useState<boolean>(() => readAgentOpen())
  // Login dialog is owned by Shell so both EmptyState and the footer cloud
  // icon can trigger it through one shared handler.
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false)
  const [remoteDialogInitialUrl, setRemoteDialogInitialUrl] = useState<string | null>(null)
  // Agent runs in the local main process with local fs tools — pointing
  // it at a remote vault would be confusing (writes would land on disk
  // here, not the server). Hide the panel + ignore the shortcut until
  // server-agent integration ships.
  const inRemote = state.workspace?.kind === 'remote'

  /**
   * Smart "connect to remote" entrypoint shared by the home-page card and
   * the footer cloud icon. If a previously-saved URL + token still
   * validate against /api/auth/me we connect silently; otherwise we open
   * the login modal (prefilled with whatever URL is on file). This is the
   * "如果是配置过了，再点击就直接进入就行了" behavior.
   */
  const handleConnectRemote = useCallback(async () => {
    const url = await ipc.remote.getUrl()
    const token = await ipc.remote.getToken()
    if (url && token) {
      try {
        const res = await fetch(`${url}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (res.ok) {
          switchToRemote({ url, getToken: () => ipc.remote.getToken() })
          await openRemoteAt(url)
          return
        }
      } catch {
        /* network/CORS failure — fall through to the dialog so the user
         * can verify URL or re-enter credentials. */
      }
    }
    setRemoteDialogInitialUrl(url)
    setRemoteDialogOpen(true)
  }, [openRemoteAt])

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
        {mode === 'empty' && <EmptyState onConnectRemote={handleConnectRemote} />}
        {mode === 'workspace' && !state.sidebarCollapsed && <Sidebar />}
        {(mode === 'workspace' || mode === 'single') && <RightPane />}
        {agentOpen && !inRemote && (
          <AgentPanel onClose={() => setAgentOpen(false)} />
        )}
      </div>

      <StatusBar
        agentOpen={agentOpen && !inRemote}
        onToggleAgent={inRemote ? undefined : () => setAgentOpen((v) => !v)}
        onConnectRemote={handleConnectRemote}
        onExitRemote={exitRemote}
      />
      <DragOverlay />
      {openChoiceRequest && (
        <OpenChoiceDialog
          request={openChoiceRequest}
          onResolve={openChoiceRequest.resolve}
        />
      )}
      {confirmRequest && <ConfirmDialog request={confirmRequest} />}
      {remoteDialogOpen && (
        <RemoteLoginDialog
          initialUrl={remoteDialogInitialUrl ?? undefined}
          onClose={() => setRemoteDialogOpen(false)}
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
          <SyncProvider>
            <Shell />
          </SyncProvider>
        </AppProvider>
      </PrefsProvider>
    </ThemeProvider>
  )
}
