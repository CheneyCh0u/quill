import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { FileNode, ViewMode } from '../types'
import { ipc, switchToLocal } from '../lib/ipc'
import { addRecent, removeRecent } from '../lib/recent'
import { validateRenameTarget } from '../lib/rename'
import { usePrefs } from './prefs'

type Workspace = {
  /**
   * Where the vault lives. 'local' = filesystem path on this machine
   * (LocalProvider); 'remote' = Quill server URL (RemoteVault). Most
   * downstream code doesn't care which — the active vault provider in
   * `ipc.vault` is what changes — but the title bar / recents list /
   * agent toggle behavior wants to know.
   */
  kind: 'local' | 'remote'
  /** Absolute fs path (local) OR server base URL (remote). */
  rootPath: string
  /** Display label — last path segment for local, hostname for remote. */
  rootName: string
  tree: FileNode[]
}

export type OpenChoiceRequest = {
  candidateName: string
  currentName: string
  dirty: boolean
  /** Resolver — the OpenChoiceDialog calls this with the user's choice
   *  (or 'cancel' on dismiss). State clears once resolved. */
  resolve: (choice: 'new' | 'current' | 'cancel') => void
}

type CurrentFile = {
  path: string | null // null = untitled (new file, not yet saved)
  content: string // last-saved content on disk
  buffer: string // editor buffer (may differ from content)
}

type State = {
  workspace: Workspace | null
  currentFile: CurrentFile | null
  viewMode: ViewMode
  sidebarCollapsed: boolean
  saving: boolean
}

type Action =
  | {
      type: 'OPEN_WORKSPACE'
      kind: 'local' | 'remote'
      rootPath: string
      rootName: string
      tree: FileNode[]
    }
  | { type: 'CLOSE_WORKSPACE' }
  | { type: 'OPEN_FILE'; path: string; content: string; viewMode: ViewMode }
  | { type: 'NEW_FILE'; viewMode: ViewMode }
  | { type: 'CLOSE_FILE' }
  | { type: 'SET_BUFFER'; buffer: string }
  | { type: 'BEGIN_SAVE' }
  | { type: 'END_SAVE'; path: string; content: string }
  | { type: 'SAVE_FAILED' }
  | { type: 'RELOAD_CURRENT_FILE'; path: string; content: string }
  | { type: 'REFRESH_TREE'; tree: FileNode[] }
  | { type: 'RENAME_FILE'; oldPath: string; newPath: string; newName: string }
  | { type: 'SET_VIEW_MODE'; mode: ViewMode }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_SIDEBAR_COLLAPSED'; collapsed: boolean }

const initialState: State = {
  workspace: null,
  currentFile: null,
  viewMode: 'split',
  sidebarCollapsed: false,
  saving: false
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'OPEN_WORKSPACE':
      return {
        ...s,
        workspace: {
          kind: a.kind,
          rootPath: a.rootPath,
          rootName: a.rootName,
          tree: a.tree
        },
        sidebarCollapsed: false
      }
    case 'CLOSE_WORKSPACE':
      return { ...initialState }
    case 'OPEN_FILE':
      return {
        ...s,
        currentFile: { path: a.path, content: a.content, buffer: a.content },
        viewMode: a.viewMode
      }
    case 'NEW_FILE':
      return {
        ...s,
        currentFile: { path: null, content: '', buffer: '' },
        viewMode: a.viewMode
      }
    case 'CLOSE_FILE':
      return { ...s, currentFile: null }
    case 'SET_BUFFER':
      return s.currentFile
        ? { ...s, currentFile: { ...s.currentFile, buffer: a.buffer } }
        : s
    case 'BEGIN_SAVE':
      return { ...s, saving: true }
    case 'END_SAVE':
      // Preserve the latest buffer (user may have typed more during async write).
      // Only path + content (last-saved snapshot) update.
      return {
        ...s,
        saving: false,
        currentFile: s.currentFile
          ? { ...s.currentFile, path: a.path, content: a.content }
          : null
      }
    case 'SAVE_FAILED':
      return { ...s, saving: false }
    case 'REFRESH_TREE':
      // No-op outside workspace mode — an open single file doesn't have
      // a tree to refresh.
      if (!s.workspace) return s
      return { ...s, workspace: { ...s.workspace, tree: a.tree } }
    case 'RELOAD_CURRENT_FILE': {
      // Triggered when something outside the editor (currently: the agent's
      // write tools) modifies the open file on disk. We always sync `content`
      // to the new disk truth, but only overwrite `buffer` if the editor was
      // clean — otherwise the user's unsaved edits would vanish silently.
      // After this, isDirty() may report true against the new disk state,
      // which is the honest outcome.
      if (!s.currentFile || s.currentFile.path !== a.path) return s
      const wasDirty = s.currentFile.buffer !== s.currentFile.content
      return {
        ...s,
        currentFile: {
          ...s.currentFile,
          content: a.content,
          buffer: wasDirty ? s.currentFile.buffer : a.content
        }
      }
    }
    case 'RENAME_FILE': {
      const updateTree = (nodes: FileNode[]): FileNode[] =>
        nodes.map((n) => {
          if (n.path === a.oldPath) return { ...n, path: a.newPath, name: a.newName }
          if (n.children) return { ...n, children: updateTree(n.children) }
          return n
        })
      return {
        ...s,
        currentFile:
          s.currentFile?.path === a.oldPath
            ? { ...s.currentFile, path: a.newPath }
            : s.currentFile,
        workspace: s.workspace
          ? { ...s.workspace, tree: updateTree(s.workspace.tree) }
          : null
      }
    }
    case 'SET_VIEW_MODE':
      return { ...s, viewMode: a.mode }
    case 'TOGGLE_SIDEBAR':
      return { ...s, sidebarCollapsed: !s.sidebarCollapsed }
    case 'SET_SIDEBAR_COLLAPSED':
      return { ...s, sidebarCollapsed: a.collapsed }
  }
}

export type AppMode = 'empty' | 'workspace' | 'single'

export function deriveMode(s: State): AppMode {
  if (s.workspace) return 'workspace'
  if (s.currentFile) return 'single'
  return 'empty'
}

export function isDirty(s: State): boolean {
  return !!s.currentFile && s.currentFile.buffer !== s.currentFile.content
}

type Ctx = {
  state: State
  mode: AppMode
  dirty: boolean
  openFolder: () => Promise<void>
  openFile: () => Promise<void>
  openFolderAt: (path: string) => Promise<void>
  /** Open a remote workspace. Caller must have already configured
   *  ipc.vault to a RemoteVault via switchToRemote(). */
  openRemoteAt: (serverUrl: string) => Promise<void>
  openFileAt: (path: string) => Promise<void>
  /** Open or new-file via user gesture — prompts for new-vs-current window
   *  when something is already open. */
  openPathWithPrompt: (target: {
    filePath?: string
    folderPath?: string
    newFile?: boolean
  }) => Promise<void>
  newFile: () => Promise<void>
  closeWorkspace: () => void
  setBuffer: (buffer: string) => void
  save: () => Promise<void>
  setViewMode: (m: ViewMode) => void
  toggleSidebar: () => void
  /** Rename the currently open file on disk and reflect in tree + recent.
   *  Throws if validation fails or fs.rename fails — caller must catch. */
  renameCurrentFile: (newName: string) => Promise<void>
  /** Re-read the open file from disk and refresh the editor buffer. Used
   *  when an external writer (the agent's write tools) has changed the file
   *  while it's open. Path-guarded so a stale event after a window switch
   *  doesn't clobber a different file. */
  reloadCurrentFile: (path: string) => Promise<void>
  /** Re-scan the workspace folder and refresh the sidebar tree. Triggered
   *  after the agent creates / writes files so newly-created entries appear
   *  immediately. No-op outside workspace mode. */
  reloadWorkspaceTree: () => Promise<void>
  /** Current pending "open in new window?" prompt, or null. The
   *  OpenChoiceDialog at the App root renders + resolves this. */
  openChoiceRequest: OpenChoiceRequest | null
}

const AppContext = createContext<Ctx | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  stateRef.current = state

  // Snapshot prefs into a ref so action callbacks stay stable. When prefs
  // change, the ref updates without re-creating every callback.
  const { prefs, setPref } = usePrefs()
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  const openFolderAt = useCallback(async (rootPath: string) => {
    const tree = await ipc.vault.list(rootPath)
    const rootName = rootPath.split(/[/\\]/).filter(Boolean).pop() ?? rootPath
    dispatch({ type: 'OPEN_WORKSPACE', kind: 'local', rootPath, rootName, tree })
    addRecent({ type: 'folder', path: rootPath, name: rootName })
  }, [])

  /**
   * Open the server's vault root. ipc.vault must already be the
   * RemoteVault (caller is responsible for calling switchToRemote()
   * before this). The "rootPath" we store is the server URL itself,
   * since the vault provider doesn't take a path — server's config
   * pins the actual filesystem location.
   */
  const openRemoteAt = useCallback(async (serverUrl: string) => {
    const tree = await ipc.vault.list('')
    let rootName = serverUrl
    try {
      rootName = new URL(serverUrl).host
    } catch {
      /* malformed URL — just use the raw string */
    }
    dispatch({
      type: 'OPEN_WORKSPACE',
      kind: 'remote',
      rootPath: serverUrl,
      rootName,
      tree
    })
  }, [])

  const openFileAt = useCallback(async (path: string) => {
    const content = await ipc.vault.read(path)
    dispatch({
      type: 'OPEN_FILE',
      path,
      content,
      viewMode: prefsRef.current.defaultViewMode
    })
    const name = path.split(/[/\\]/).pop() ?? path
    addRecent({ type: 'file', path, name })
  }, [])

  // Direct mutation of the current window's state — used by sidebar tree
  // clicks and by main-process-initiated initial actions (no prompt).
  const newFileInCurrent = useCallback(() => {
    dispatch({ type: 'NEW_FILE', viewMode: prefsRef.current.defaultViewMode })
  }, [])

  // Renderer-side prompt state replacing the old native sheet via
  // `dialog:confirmOpenChoice`. `openPathWithPrompt` parks a promise in
  // `openChoiceRequest`; the `OpenChoiceDialog` at the App root resolves
  // it on button click and clears the state via the callback we attach.
  const [openChoiceRequest, setOpenChoiceRequest] = useState<OpenChoiceRequest | null>(
    null
  )

  const askOpenChoice = useCallback(
    (candidateName: string, currentName: string, dirty: boolean) =>
      new Promise<'new' | 'current' | 'cancel'>((resolve) => {
        setOpenChoiceRequest({
          candidateName,
          currentName,
          dirty,
          resolve: (choice) => {
            setOpenChoiceRequest(null)
            resolve(choice)
          }
        })
      }),
    []
  )

  const openPathWithPrompt = useCallback(
    async (target: { filePath?: string; folderPath?: string; newFile?: boolean }) => {
      const cur = stateRef.current.currentFile
      // Empty state: just apply, no prompt.
      if (!cur) {
        if (target.filePath) return openFileAt(target.filePath)
        if (target.folderPath) return openFolderAt(target.folderPath)
        if (target.newFile) return newFileInCurrent()
        return
      }
      const candidateName = target.filePath
        ? (target.filePath.split(/[/\\]/).pop() ?? '文件')
        : target.folderPath
          ? (target.folderPath.split(/[/\\]/).pop() ?? '文件夹')
          : '未命名'
      const currentName = cur.path
        ? (cur.path.split(/[/\\]/).pop() ?? '未命名')
        : 'Untitled'
      const choice = await askOpenChoice(
        candidateName,
        currentName,
        isDirty(stateRef.current)
      )
      if (choice === 'cancel') return
      if (choice === 'new') {
        await ipc.openInNewWindow(target)
        return
      }
      // current
      if (target.filePath) await openFileAt(target.filePath)
      else if (target.folderPath) await openFolderAt(target.folderPath)
      else if (target.newFile) newFileInCurrent()
    },
    [openFileAt, openFolderAt, newFileInCurrent, askOpenChoice]
  )

  const openFolder = useCallback(async () => {
    const p = await ipc.openFolderDialog()
    if (p) await openPathWithPrompt({ folderPath: p })
  }, [openPathWithPrompt])

  const openFile = useCallback(async () => {
    const p = await ipc.openFileDialog()
    if (p) await openPathWithPrompt({ filePath: p })
  }, [openPathWithPrompt])

  const newFile = useCallback(async () => {
    await openPathWithPrompt({ newFile: true })
  }, [openPathWithPrompt])

  const closeWorkspace = useCallback(() => {
    // Closing a remote workspace also drops the stored URL/token and
    // switches the active vault back to local. Local → empty is unchanged.
    if (stateRef.current.workspace?.kind === 'remote') {
      void ipc.remote.clear()
      switchToLocal()
    }
    dispatch({ type: 'CLOSE_WORKSPACE' })
  }, [])

  const setBuffer = useCallback((buffer: string) => {
    dispatch({ type: 'SET_BUFFER', buffer })
  }, [])

  const save = useCallback(async () => {
    const cur = stateRef.current.currentFile
    if (!cur) return
    // Nothing to save: already on disk and buffer matches.
    if (cur.path !== null && cur.buffer === cur.content) return

    let path = cur.path
    const isFirstSave = path === null
    if (isFirstSave) {
      const ext = prefsRef.current.lastNewFileExt || 'md'
      path = await ipc.saveFileDialog(`untitled.${ext}`)
      if (!path) return // user cancelled
    }

    // Snapshot the buffer at save time so we know what we wrote.
    const snapshot = cur.buffer
    dispatch({ type: 'BEGIN_SAVE' })
    try {
      await ipc.vault.write(path!, snapshot)
      dispatch({ type: 'END_SAVE', path: path!, content: snapshot })
      if (isFirstSave) {
        const name = path!.split(/[/\\]/).pop() ?? path!
        addRecent({ type: 'file', path: path!, name })
        // Remember the extension the user chose so the next untitled
        // defaults to the same kind.
        const m = name.match(/[^.]\.([a-z0-9]+)$/i)
        if (m) setPref('lastNewFileExt', m[1].toLowerCase())
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('save failed', err)
      dispatch({ type: 'SAVE_FAILED' })
    }
  }, [])

  const setViewMode = useCallback((m: ViewMode) => dispatch({ type: 'SET_VIEW_MODE', mode: m }), [])
  const toggleSidebar = useCallback(() => dispatch({ type: 'TOGGLE_SIDEBAR' }), [])

  const reloadCurrentFile = useCallback(async (path: string) => {
    // Re-check path against ref at call time — by the time fs.readFile
    // resolves, the user may have switched files.
    const cur = stateRef.current.currentFile
    if (!cur || cur.path !== path) return
    const content = await ipc.vault.read(path)
    if (stateRef.current.currentFile?.path !== path) return
    dispatch({ type: 'RELOAD_CURRENT_FILE', path, content })
  }, [])

  const reloadWorkspaceTree = useCallback(async () => {
    // Snapshot the workspace root at call time. If the user closes the
    // workspace mid-IO we skip the dispatch — reducer would no-op anyway,
    // but this avoids a wasted listDir on a still-mounted tree.
    const ws = stateRef.current.workspace
    if (!ws) return
    const rootAtCall = ws.rootPath
    const tree = await ipc.vault.list(rootAtCall)
    if (stateRef.current.workspace?.rootPath !== rootAtCall) return
    dispatch({ type: 'REFRESH_TREE', tree })
  }, [])

  const renameCurrentFile = useCallback(async (newName: string) => {
    const cur = stateRef.current.currentFile
    if (!cur?.path) throw new Error('未保存的文件不能重命名')
    const result = validateRenameTarget(cur.path, newName)
    if (!result.ok) throw new Error(result.error)
    if (result.newPath === cur.path) return // no-op
    await ipc.vault.rename(cur.path, result.newPath)
    dispatch({
      type: 'RENAME_FILE',
      oldPath: cur.path,
      newPath: result.newPath,
      newName: result.newName
    })
    removeRecent(cur.path)
    addRecent({ type: 'file', path: result.newPath, name: result.newName })
  }, [])

  // Wire native menu commands
  useEffect(() => {
    return ipc.onMenu((cmd) => {
      if (cmd === 'open-folder') void openFolder()
      else if (cmd === 'open-file') void openFile()
      else if (cmd === 'save') void save()
      else if (cmd === 'new-file') void newFile()
      else if (cmd === 'close-folder') closeWorkspace()
    })
  }, [openFolder, openFile, save, newFile, closeWorkspace])

  // Wire main → renderer open-file event (Finder "Open With" + new windows
  // bootstrapped by main with an `initial: open-file` action). The window
  // that receives this event was created for the file, so always apply
  // directly without prompting.
  useEffect(() => {
    return ipc.onOpenFile((path) => {
      void openFileAt(path)
    })
  }, [openFileAt])

  // Same for folder — fires when main creates a new window with an
  // `initial: open-folder` action.
  useEffect(() => {
    return ipc.onOpenFolder((path) => {
      void openFolderAt(path)
    })
  }, [openFolderAt])

  const value = useMemo<Ctx>(
    () => ({
      state,
      mode: deriveMode(state),
      dirty: isDirty(state),
      openFolder,
      openFile,
      openFolderAt,
      openRemoteAt,
      openFileAt,
      openPathWithPrompt,
      newFile,
      closeWorkspace,
      setBuffer,
      save,
      setViewMode,
      toggleSidebar,
      renameCurrentFile,
      reloadCurrentFile,
      reloadWorkspaceTree,
      openChoiceRequest
    }),
    [
      state,
      openFolder,
      openFile,
      openFolderAt,
      openRemoteAt,
      openFileAt,
      openPathWithPrompt,
      newFile,
      closeWorkspace,
      setBuffer,
      save,
      setViewMode,
      toggleSidebar,
      renameCurrentFile,
      reloadCurrentFile,
      reloadWorkspaceTree,
      openChoiceRequest
    ]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): Ctx {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}
