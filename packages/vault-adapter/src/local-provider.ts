import type { FileNode, FileStat } from '@quill/shared-types'
import { NotSupportedError, type VaultProvider } from './types'

/**
 * Structural subset of `window.quill.fs` (defined in the desktop preload)
 * that LocalProvider needs. Declared structurally so this package stays
 * decoupled from Electron and from the desktop app's preload module —
 * the renderer constructs LocalProvider by passing the real bridge in.
 */
export interface QuillFsBridge {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  listDir(path: string): Promise<FileNode[]>
  stat(path: string): Promise<FileStat>
}

export class LocalProvider implements VaultProvider {
  readonly kind = 'local' as const

  constructor(private readonly fs: QuillFsBridge) {}

  read(path: string): Promise<string> {
    return this.fs.readFile(path)
  }

  write(path: string, content: string): Promise<void> {
    return this.fs.writeFile(path, content)
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    return this.fs.rename(oldPath, newPath)
  }

  list(path: string): Promise<FileNode[]> {
    return this.fs.listDir(path)
  }

  stat(path: string): Promise<FileStat> {
    return this.fs.stat(path)
  }

  // The desktop IPC doesn't expose mkdir / delete / deleteDir yet — no
  // current consumer in the renderer calls them. When the workspace tree
  // grows new/delete UI on desktop, the main process adds matching IPC
  // handlers and these stubs get real implementations.
  mkdir(_path: string): Promise<void> {
    return Promise.reject(new NotSupportedError('mkdir', this.kind))
  }

  delete(_path: string): Promise<void> {
    return Promise.reject(new NotSupportedError('delete', this.kind))
  }

  deleteDir(_path: string, _recursive: boolean): Promise<void> {
    return Promise.reject(new NotSupportedError('deleteDir', this.kind))
  }
}
