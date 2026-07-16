import type { FileNode, FileStat } from '@quill/shared-types'
import type { VaultProvider } from './types'

/**
 * Structural subset of `window.quill.fs` (defined in the desktop preload)
 * that LocalProvider needs. Declared structurally so this package stays
 * decoupled from Electron and from the desktop app's preload module —
 * the renderer constructs LocalProvider by passing the real bridge in.
 */
export interface QuillFsBridge {
  readFile(path: string): Promise<string>
  readFileBinary(path: string): Promise<Uint8Array>
  writeFile(path: string, content: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  listDir(path: string): Promise<FileNode[]>
  stat(path: string): Promise<FileStat>
  mkdir(path: string): Promise<void>
  delete(path: string): Promise<void>
  deleteDir(path: string, recursive: boolean): Promise<void>
}

export class LocalProvider implements VaultProvider {
  readonly kind = 'local' as const

  constructor(private readonly fs: QuillFsBridge) {}

  read(path: string): Promise<string> {
    return this.fs.readFile(path)
  }

  readBinary(path: string): Promise<Uint8Array> {
    return this.fs.readFileBinary(path)
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

  mkdir(path: string): Promise<void> {
    return this.fs.mkdir(path)
  }

  delete(path: string): Promise<void> {
    return this.fs.delete(path)
  }

  deleteDir(path: string, recursive: boolean): Promise<void> {
    return this.fs.deleteDir(path, recursive)
  }
}
