import { useEffect, useState } from 'react'
import { Upload } from 'lucide-react'
import { isSupportedTextFile } from '@quill/shared-types'
import { ipc } from '../lib/ipc'
import { useApp } from '../state/app'

export function DragOverlay() {
  const { openPathWithPrompt } = useApp()
  const [over, setOver] = useState(false)

  useEffect(() => {
    let counter = 0

    const onDragEnter = (e: DragEvent): void => {
      e.preventDefault()
      counter += 1
      if (e.dataTransfer?.types.includes('Files')) setOver(true)
    }
    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent): void => {
      e.preventDefault()
      counter -= 1
      if (counter <= 0) {
        counter = 0
        setOver(false)
      }
    }
    const onDrop = async (e: DragEvent): Promise<void> => {
      e.preventDefault()
      counter = 0
      setOver(false)
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return

      for (const f of Array.from(files)) {
        // Electron extends File with `path`
        const path = (f as File & { path?: string }).path
        if (!path) continue
        try {
          const stat = await ipc.vault.stat(path)
          if (stat.isDirectory) {
            await openPathWithPrompt({ folderPath: path })
            return
          }
          if (stat.isFile && isSupportedTextFile(path)) {
            await openPathWithPrompt({ filePath: path })
            return
          }
        } catch {
          // ignore
        }
      }
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [openPathWithPrompt])

  if (!over) return null

  return (
    <div className="absolute inset-0 z-50 pointer-events-none flex items-center justify-center bg-[var(--ink)]/20 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 px-10 py-7 rounded-[10px] bg-[var(--paper)] border-2 border-dashed border-[var(--accent)]/50 shadow-lg">
        <Upload className="w-7 h-7 text-[var(--accent)]" />
        <span className="font-serif-zh italic text-sm text-[var(--ink-soft)]">
          松手以打开文件或文件夹
        </span>
      </div>
    </div>
  )
}
