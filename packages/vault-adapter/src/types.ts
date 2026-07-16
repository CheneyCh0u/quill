import type { FileNode, FileStat } from '@quill/shared-types'

export type VaultProviderKind = 'local' | 'remote' | 'fs-access'

/**
 * Thrown when a provider doesn't (yet) support an operation. Different from
 * a runtime error: the caller can use this to feature-detect at the UI
 * layer (hide a button vs surface a generic failure).
 */
export class NotSupportedError extends Error {
  constructor(operation: string, kind: VaultProviderKind) {
    super(`operation "${operation}" not supported by ${kind} provider`)
    this.name = 'NotSupportedError'
  }
}

/**
 * Storage backend abstraction for a Quill vault.
 *
 * Implementations:
 * - LocalProvider — wraps desktop's electron IPC (window.quill.fs.*).
 * - RemoteVault — hits apps/server REST.
 * - (planned) FileSystemAccessProvider — PC web local mode.
 *
 * Sync-state operations (push/pull/syncStatus) and resource-URL resolution
 * are still intentionally absent — they'll be added with the remote sync
 * UI work (docs/web-server.md "同步模型").
 */
export interface VaultProvider {
  readonly kind: VaultProviderKind

  // Basic CRUD
  read(path: string): Promise<string>
  /** Raw bytes for view-only formats (images / pdf, #132). */
  readBinary(path: string): Promise<Uint8Array>
  write(path: string, content: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  list(path: string): Promise<FileNode[]>
  stat(path: string): Promise<FileStat>

  // Directory + delete operations. Implementations that can't yet provide
  // these throw NotSupportedError so the UI can degrade gracefully.
  mkdir(path: string): Promise<void>
  delete(path: string): Promise<void>
  deleteDir(path: string, recursive: boolean): Promise<void>
}
