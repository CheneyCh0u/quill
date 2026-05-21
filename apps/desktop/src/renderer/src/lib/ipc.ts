import type { FileNode, MenuCommand } from '../types'

export const ipc = {
  openFolderDialog: (): Promise<string | null> => window.quill.dialog.openFolder(),
  openFileDialog: (): Promise<string | null> => window.quill.dialog.openFile(),
  saveFileDialog: (
    defaultName?: string,
    filters?: Array<{ name: string; extensions: string[] }>
  ): Promise<string | null> => window.quill.dialog.saveFile(defaultName, filters),
  confirmOpenChoice: (args: {
    candidateName: string
    currentName: string
    dirty: boolean
  }): Promise<'new' | 'current' | 'cancel'> =>
    window.quill.dialog.confirmOpenChoice(args),
  openInNewWindow: (args: {
    filePath?: string
    folderPath?: string
    newFile?: boolean
  }): Promise<void> => window.quill.app.openInNewWindow(args),
  readFile: (path: string): Promise<string> => window.quill.fs.readFile(path),
  writeFile: (path: string, content: string): Promise<void> =>
    window.quill.fs.writeFile(path, content),
  renameFile: (oldPath: string, newPath: string): Promise<void> =>
    window.quill.fs.rename(oldPath, newPath),
  listDir: (path: string): Promise<FileNode[]> => window.quill.fs.listDir(path),
  onOpenFile: (cb: (path: string) => void): (() => void) =>
    window.quill.events.onOpenFile(cb),
  onOpenFolder: (cb: (path: string) => void): (() => void) =>
    window.quill.events.onOpenFolder(cb),
  onMenu: (cb: (cmd: MenuCommand) => void): (() => void) =>
    window.quill.events.onMenuCommand(cb),
  exportPdf: (args: { html: string; defaultName: string }): Promise<string | null> =>
    window.quill.exportPdf(args),
  revealInFolder: (path: string): Promise<void> => window.quill.shell.reveal(path)
}
