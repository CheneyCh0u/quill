# Manual Refresh Controls

## Goal

Let users rescan the open workspace and reload the current file after another
application changes files on disk, without closing and reopening Quill.

## User Interface

- Add a compact refresh icon button to the workspace header beside the existing
  folder actions. It rescans the current workspace tree.
- Add a matching refresh icon button to the file header when the current file
  has a path on disk. Untitled files do not show the button.
- While an action is running, disable its button and rotate the refresh icon.
- Keep successful, non-conflicting refreshes quiet. Show a concise error message
  if reading the tree or file fails.

The controls reuse Quill's existing icon-button geometry, colors, hover states,
and tooltips. They do not change the app's established paper-like visual
direction.

## Refresh Behavior

### Workspace tree

The tree button calls the existing workspace rescan operation. The operation
captures the active workspace root and only applies its result if the same
workspace is still open when the asynchronous read finishes.

### Current file

Refreshing a file reads the latest disk content and compares three values:

1. The last disk content known to Quill (`content`).
2. The current editor buffer (`buffer`).
3. The newly read disk content.

The result is handled as follows:

| Editor changed | Disk changed | Result |
| --- | --- | --- |
| No | No | Keep the current state |
| No | Yes | Replace the known content and editor buffer |
| Yes | No | Keep the unsaved editor buffer |
| Yes | Yes | Ask before replacing both values with disk content |

If both sides changed but now contain the same text, there is no conflict.
Adopt that text as the new clean disk baseline without prompting.

The conflict prompt explains that continuing discards unsaved changes in
Quill. Cancelling leaves both the editor buffer and its original disk baseline
unchanged. Confirming replaces both with the newly read disk content, leaving
the file clean.

The refresh remains path-guarded: if the user switches files while the read or
confirmation is in progress, the result is ignored rather than applied to the
new file.

## State and Component Boundaries

- `state/app.tsx` owns disk reads, conflict detection, confirmation, and stale
  path protection.
- `Sidebar.tsx` owns the tree refresh button and its local pending/error state.
- `PaneHeader.tsx` owns the file refresh button and its local pending/error
  state.
- The existing agent-triggered reload path keeps its current behavior. Agent
  writes must not unexpectedly open a user confirmation dialog.

The manual file refresh is therefore a separate app action from the existing
agent-triggered `reloadCurrentFile` operation.

## Errors and Accessibility

- Buttons include Chinese tooltips and accessible labels.
- Pending buttons are disabled to prevent duplicate reads.
- Read failures do not change the displayed tree or document.
- A short inline error near the relevant header action is preferred over a
  success toast. The error clears on the next refresh attempt.

## Tests

Automated tests cover the pure refresh decision for:

- unchanged editor and disk;
- disk-only changes;
- editor-only changes;
- simultaneous editor and disk changes;
- cancelling a conflict;
- confirming a conflict;
- stale file paths;
- replacing the workspace tree after a rescan.

Component or rendered verification confirms that both controls appear in the
correct headers, use pending states, and remain usable in compact window sizes.

## Out of Scope

- File-system watchers and automatic background refresh.
- Merging simultaneous edits.
- Refresh history or change diffs.
- A global refresh shortcut.
