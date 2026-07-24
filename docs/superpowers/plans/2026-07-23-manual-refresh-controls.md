# Manual Refresh Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe manual refresh controls for the workspace tree and current file so external disk changes appear without reopening Quill.

**Architecture:** A focused library module decides whether a disk read is unchanged, safe to apply, or conflicting, and orchestrates the confirmation flow through injected dependencies. App context adapts that operation to Quill state and IPC, while the two headers share one small refresh icon button component and keep pending/error presentation local.

**Tech Stack:** React 18, TypeScript, Bun test, Electron IPC through the existing vault adapter, Tailwind CSS, lucide-react.

## Global Constraints

- Only prompt when the Quill buffer and disk both changed from the known baseline and their final text differs.
- Keep successful and non-conflicting refreshes quiet.
- Never overwrite another file when an asynchronous read or confirmation resolves after navigation.
- Do not add file-system watchers, merging, history, or a global keyboard shortcut.
- Reuse Quill's current paper-like header styling and existing confirmation dialog.
- Do not add dependencies.

---

## File Map

- Create `apps/desktop/src/renderer/src/lib/file-refresh.ts`: pure decision and refresh orchestration.
- Create `apps/desktop/src/renderer/src/lib/file-refresh.test.ts`: decision, conflict, cancellation, and stale-path tests.
- Modify `apps/desktop/src/renderer/src/state/app.tsx`: force-apply action and app-context adapter.
- Modify `apps/desktop/src/renderer/src/state/app.test.ts`: reducer test for a confirmed force reload.
- Create `apps/desktop/src/renderer/src/components/RefreshButton.tsx`: shared accessible icon button.
- Create `apps/desktop/src/renderer/src/components/RefreshButton.test.tsx`: static markup checks for pending state.
- Modify `apps/desktop/src/renderer/src/components/Sidebar.tsx`: workspace-tree refresh UI.
- Modify `apps/desktop/src/renderer/src/components/PaneHeader.tsx`: current-file refresh UI.

### Task 1: Classify file refreshes

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/file-refresh.ts`
- Test: `apps/desktop/src/renderer/src/lib/file-refresh.test.ts`

**Interfaces:**
- Produces: `decideFileRefresh(knownContent: string, buffer: string, diskContent: string): FileRefreshDecision`
- Produces: `FileRefreshDecision = 'unchanged' | 'reload' | 'conflict'`

- [ ] **Step 1: Write the failing decision-matrix test**

```ts
import { describe, expect, it } from 'bun:test'
import { decideFileRefresh } from './file-refresh'

describe('decideFileRefresh', () => {
  it.each([
    ['unchanged editor and disk', 'old', 'old', 'old', 'unchanged'],
    ['disk-only change', 'old', 'old', 'disk', 'reload'],
    ['editor-only change', 'old', 'editor', 'old', 'unchanged'],
    ['different two-sided changes', 'old', 'editor', 'disk', 'conflict'],
    ['matching two-sided changes', 'old', 'same', 'same', 'reload']
  ] as const)('%s returns %s', (_label, known, buffer, disk, expected) => {
    expect(decideFileRefresh(known, buffer, disk)).toBe(expected)
  })
})
```

- [ ] **Step 2: Run the test and verify Red**

Run: `bun test apps/desktop/src/renderer/src/lib/file-refresh.test.ts`

Expected: FAIL because `./file-refresh` does not exist.

- [ ] **Step 3: Add the minimal classifier**

```ts
export type FileRefreshDecision = 'unchanged' | 'reload' | 'conflict'

export function decideFileRefresh(
  knownContent: string,
  buffer: string,
  diskContent: string
): FileRefreshDecision {
  if (diskContent === knownContent) return 'unchanged'
  if (buffer === knownContent || buffer === diskContent) return 'reload'
  return 'conflict'
}
```

- [ ] **Step 4: Run the test and verify Green**

Run: `bun test apps/desktop/src/renderer/src/lib/file-refresh.test.ts`

Expected: 5 passing cases, 0 failures.

- [ ] **Step 5: Commit the classifier**

```bash
git add apps/desktop/src/renderer/src/lib/file-refresh.ts apps/desktop/src/renderer/src/lib/file-refresh.test.ts
git commit -m "feat(renderer): classify manual file refreshes"
```

### Task 2: Orchestrate a safe manual file reload

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/file-refresh.ts`
- Modify: `apps/desktop/src/renderer/src/lib/file-refresh.test.ts`
- Modify: `apps/desktop/src/renderer/src/state/app.tsx:69-203,240-300,591-635,780-835`
- Modify: `apps/desktop/src/renderer/src/state/app.test.ts:1-82`

**Interfaces:**
- Consumes: `decideFileRefresh(...)` from Task 1.
- Produces: `refreshFileFromDisk(deps: FileRefreshDependencies): Promise<FileRefreshResult>`.
- Produces: app context method `refreshCurrentFile(): Promise<void>`.
- Produces: reducer action `{ type: 'APPLY_FILE_REFRESH'; path: string; content: string }`.

- [ ] **Step 1: Write failing orchestration tests**

Append tests that construct mutable `currentFile`, record `apply` calls, and verify:

```ts
import { refreshFileFromDisk, type RefreshableFile } from './file-refresh'

describe('refreshFileFromDisk', () => {
  function harness(file: RefreshableFile, diskContent: string, confirm = false) {
    let current: RefreshableFile | null = file
    const applied: Array<{ path: string; content: string }> = []
    let confirmationCount = 0
    return {
      setCurrent: (next: RefreshableFile | null) => { current = next },
      applied,
      confirmationCount: () => confirmationCount,
      run: () => refreshFileFromDisk({
        getCurrentFile: () => current,
        read: async () => diskContent,
        confirmConflict: async () => { confirmationCount += 1; return confirm },
        apply: (path, content) => applied.push({ path, content })
      })
    }
  }

  it('quietly applies a disk-only change', async () => {
    const h = harness({ path: '/r/a.md', content: 'old', buffer: 'old' }, 'disk')
    expect(await h.run()).toBe('reloaded')
    expect(h.applied).toEqual([{ path: '/r/a.md', content: 'disk' }])
    expect(h.confirmationCount()).toBe(0)
  })

  it('preserves an editor-only change', async () => {
    const h = harness({ path: '/r/a.md', content: 'old', buffer: 'editor' }, 'old')
    expect(await h.run()).toBe('unchanged')
    expect(h.applied).toEqual([])
  })

  it('keeps the buffer when a conflict is cancelled', async () => {
    const h = harness({ path: '/r/a.md', content: 'old', buffer: 'editor' }, 'disk')
    expect(await h.run()).toBe('cancelled')
    expect(h.applied).toEqual([])
    expect(h.confirmationCount()).toBe(1)
  })

  it('applies disk content when a conflict is confirmed', async () => {
    const h = harness({ path: '/r/a.md', content: 'old', buffer: 'editor' }, 'disk', true)
    expect(await h.run()).toBe('reloaded')
    expect(h.applied).toEqual([{ path: '/r/a.md', content: 'disk' }])
  })

  it('ignores the result after the active file changes', async () => {
    let release!: (value: string) => void
    let current: RefreshableFile | null = { path: '/r/a.md', content: 'old', buffer: 'old' }
    const applied: unknown[] = []
    const run = refreshFileFromDisk({
      getCurrentFile: () => current,
      read: () => new Promise<string>((resolve) => { release = resolve }),
      confirmConflict: async () => true,
      apply: (...args) => applied.push(args)
    })
    current = { path: '/r/b.md', content: 'b', buffer: 'b' }
    release('disk')
    expect(await run).toBe('stale')
    expect(applied).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests and verify Red**

Run: `bun test apps/desktop/src/renderer/src/lib/file-refresh.test.ts`

Expected: FAIL because `refreshFileFromDisk` and `RefreshableFile` are not exported.

- [ ] **Step 3: Implement the orchestration**

```ts
export type RefreshableFile = {
  path: string | null
  content: string
  buffer: string
}

export type FileRefreshDependencies = {
  getCurrentFile: () => RefreshableFile | null
  read: (path: string) => Promise<string>
  confirmConflict: () => Promise<boolean>
  apply: (path: string, content: string) => void
}

export type FileRefreshResult = 'unchanged' | 'reloaded' | 'cancelled' | 'stale'

export async function refreshFileFromDisk(
  deps: FileRefreshDependencies
): Promise<FileRefreshResult> {
  const initial = deps.getCurrentFile()
  if (!initial?.path) return 'unchanged'
  const path = initial.path
  const diskContent = await deps.read(path)
  const current = deps.getCurrentFile()
  if (!current || current.path !== path) return 'stale'
  const decision = decideFileRefresh(current.content, current.buffer, diskContent)
  if (decision === 'unchanged') return 'unchanged'
  if (decision === 'conflict' && !(await deps.confirmConflict())) return 'cancelled'
  if (deps.getCurrentFile()?.path !== path) return 'stale'
  deps.apply(path, diskContent)
  return 'reloaded'
}
```

- [ ] **Step 4: Run the library tests and verify Green**

Run: `bun test apps/desktop/src/renderer/src/lib/file-refresh.test.ts`

Expected: all decision and orchestration cases pass.

- [ ] **Step 5: Add a failing reducer test for confirmed replacement**

```ts
it('replaces both disk baseline and dirty buffer for a confirmed manual refresh', () => {
  const next = reducer(
    {
      workspace: null,
      currentFile: { path: '/r/a.md', content: 'old', buffer: 'editor' },
      viewMode: 'split',
      sidebarCollapsed: false,
      saving: false
    },
    { type: 'APPLY_FILE_REFRESH', path: '/r/a.md', content: 'disk' }
  )
  expect(next.currentFile).toEqual({ path: '/r/a.md', content: 'disk', buffer: 'disk' })
})
```

- [ ] **Step 6: Run the reducer test and verify Red**

Run: `bun test apps/desktop/src/renderer/src/state/app.test.ts -t "confirmed manual refresh"`

Expected: FAIL because the reducer does not handle `APPLY_FILE_REFRESH`.

- [ ] **Step 7: Integrate the action with app context**

In `state/app.tsx`:

```ts
import { refreshFileFromDisk } from '../lib/file-refresh'

// Action union
| { type: 'APPLY_FILE_REFRESH'; path: string; content: string }

// Reducer, path guarded
case 'APPLY_FILE_REFRESH':
  if (!s.currentFile || s.currentFile.path !== a.path) return s
  return {
    ...s,
    currentFile: { ...s.currentFile, content: a.content, buffer: a.content }
  }

// Context contract
refreshCurrentFile: () => Promise<void>

// Provider, after askConfirm is defined
const refreshCurrentFile = useCallback(async () => {
  await refreshFileFromDisk({
    getCurrentFile: () => stateRef.current.currentFile,
    read: ipc.vault.read,
    confirmConflict: () => askConfirm({
      title: '文件已在其他地方修改',
      message: '刷新会丢弃 Quill 中尚未保存的修改，是否继续？',
      confirmLabel: '重新加载',
      cancelLabel: '保留修改'
    }),
    apply: (path, content) => dispatch({ type: 'APPLY_FILE_REFRESH', path, content })
  })
}, [askConfirm])
```

Expose `refreshCurrentFile` in both the context value and dependency list. Keep the existing agent-triggered `reloadCurrentFile(path)` unchanged.

- [ ] **Step 8: Run focused tests and typecheck**

Run: `bun test apps/desktop/src/renderer/src/lib/file-refresh.test.ts apps/desktop/src/renderer/src/state/app.test.ts`

Expected: all tests pass.

Run: `bun --filter @quill/desktop typecheck`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 9: Commit safe reload behavior**

```bash
git add apps/desktop/src/renderer/src/lib/file-refresh.ts apps/desktop/src/renderer/src/lib/file-refresh.test.ts apps/desktop/src/renderer/src/state/app.tsx apps/desktop/src/renderer/src/state/app.test.ts
git commit -m "feat(renderer): reload externally changed files safely"
```

### Task 3: Add the two refresh controls

**Files:**
- Create: `apps/desktop/src/renderer/src/components/RefreshButton.tsx`
- Create: `apps/desktop/src/renderer/src/components/RefreshButton.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx:1-70`
- Modify: `apps/desktop/src/renderer/src/components/PaneHeader.tsx:1-177`

**Interfaces:**
- Consumes: app context methods `reloadWorkspaceTree()` and `refreshCurrentFile()`.
- Produces: `RefreshButton({ label, refreshing, onClick, size? })`.

- [ ] **Step 1: Write the failing shared-button test**

```tsx
import { expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RefreshButton } from './RefreshButton'

it('marks a pending refresh as disabled and animated', () => {
  const html = renderToStaticMarkup(
    <RefreshButton label="刷新文件" refreshing onClick={() => undefined} />
  )
  expect(html).toContain('aria-label="刷新文件"')
  expect(html).toContain('disabled=""')
  expect(html).toContain('animate-spin')
})
```

- [ ] **Step 2: Run the component test and verify Red**

Run: `bun test apps/desktop/src/renderer/src/components/RefreshButton.test.tsx`

Expected: FAIL because `RefreshButton` does not exist.

- [ ] **Step 3: Implement the shared button**

```tsx
import { RefreshCw } from 'lucide-react'

type Props = {
  label: string
  refreshing: boolean
  onClick: () => void
  size?: 'compact' | 'regular'
}

export function RefreshButton({ label, refreshing, onClick, size = 'compact' }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={refreshing}
      aria-label={label}
      title={label}
      className={`${size === 'regular' ? 'p-1.5' : 'p-1'} no-drag rounded-md text-[var(--ink-faint)] transition hover:bg-[var(--paper-soft)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-60`}
    >
      <RefreshCw className={`${size === 'regular' ? 'h-4 w-4' : 'h-3.5 w-3.5'} ${refreshing ? 'animate-spin' : ''}`} />
    </button>
  )
}
```

- [ ] **Step 4: Run the component test and verify Green**

Run: `bun test apps/desktop/src/renderer/src/components/RefreshButton.test.tsx`

Expected: 1 pass, 0 failures.

- [ ] **Step 5: Add pending/error handlers to both headers**

In each component, add separate `refreshing` and `refreshError` state. The handler clears the error, awaits the relevant context action, records `刷新失败` on rejection, logs the original error, and always clears pending state:

```tsx
const [refreshing, setRefreshing] = useState(false)
const [refreshError, setRefreshError] = useState(false)

const handleRefresh = useCallback(async () => {
  if (refreshing) return
  setRefreshing(true)
  setRefreshError(false)
  try {
    await refreshCurrentFile() // Sidebar uses reloadWorkspaceTree()
  } catch (err) {
    console.error('refresh failed', err)
    setRefreshError(true)
  } finally {
    setRefreshing(false)
  }
}, [refreshing, refreshCurrentFile])
```

Render `RefreshButton` beside the existing header actions. In `PaneHeader`, only render it when `cur?.path` is truthy. Show an `aria-live="polite"` inline `刷新失败` label when the action rejects. In the sidebar, use the existing small workspace metadata line for the same visible error without increasing header height.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `bun test apps/desktop/src/renderer/src/components/RefreshButton.test.tsx apps/desktop/src/renderer/src/lib/file-refresh.test.ts apps/desktop/src/renderer/src/state/app.test.ts`

Expected: all focused tests pass.

Run: `bun --filter @quill/desktop typecheck`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 7: Commit the controls**

```bash
git add apps/desktop/src/renderer/src/components/RefreshButton.tsx apps/desktop/src/renderer/src/components/RefreshButton.test.tsx apps/desktop/src/renderer/src/components/Sidebar.tsx apps/desktop/src/renderer/src/components/PaneHeader.tsx
git commit -m "feat(renderer): add workspace and file refresh controls"
```

### Task 4: Verify the full feature

**Files:**
- Verify: all files listed above.

**Interfaces:**
- Consumes: the complete manual refresh feature from Tasks 1 through 3.
- Produces: fresh automated and visual evidence for issue #145.

- [ ] **Step 1: Run the complete test suite**

Run: `bun test`

Expected: 0 failures.

- [ ] **Step 2: Run workspace typechecking and desktop build**

Run: `bun typecheck`

Expected: exit 0.

Run: `bun run build:desktop`

Expected: exit 0 and all Electron bundles generated successfully.

- [ ] **Step 3: Verify the real desktop surface**

Run: `bun run dev:desktop`, open a workspace, and verify:

1. The tree refresh button appears with the existing sidebar actions.
2. The file refresh button appears in the file header but not for Untitled.
3. An external clean-file edit reloads without a dialog.
4. A Quill-only unsaved edit remains untouched when disk is unchanged.
5. Different simultaneous edits show the conflict confirmation.
6. Cancelling keeps the Quill buffer, confirming shows disk content.
7. Both icons animate and disable while pending.
8. The headers remain coherent at the minimum supported 720 px window width.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check origin/main...HEAD && git status --short`

Expected: no whitespace errors and only intentional files present.
