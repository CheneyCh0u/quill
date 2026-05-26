/**
 * Imperative queue for in-app modal dialogs (alert / confirm / prompt),
 * isolated from React so the queue/resolve mechanics can be unit-tested
 * without a DOM. The React layer in `dialogs.tsx` subscribes to this and
 * renders whatever is at the head.
 *
 * Multiple dialogs are queued, not stacked — opening a second alert while
 * an alert is up parks it behind the current one and shows it only after
 * the first resolves. Simpler than supporting overlapping modals, and
 * matches how the native window.* dialogs serialized too.
 */

import type { ReactNode } from 'react'

export type AlertOptions = {
  title?: string
  message: ReactNode
  okText?: string
}

export type ConfirmOptions = {
  title?: string
  message: ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

export type PromptOptions = {
  title?: string
  label?: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
  cancelText?: string
  /** Return an error message to keep the dialog open; return null to allow submit. */
  validate?: (value: string) => string | null
}

export type AlertRequest = {
  kind: 'alert'
  opts: AlertOptions
  resolve: (value: void) => void
}
export type ConfirmRequest = {
  kind: 'confirm'
  opts: ConfirmOptions
  resolve: (value: boolean) => void
}
export type PromptRequest = {
  kind: 'prompt'
  opts: PromptOptions
  resolve: (value: string | null) => void
}
export type DialogRequest = AlertRequest | ConfirmRequest | PromptRequest

export class DialogStore {
  private queue: DialogRequest[] = []
  private subscribers = new Set<() => void>()

  enqueue(req: DialogRequest): void {
    this.queue.push(req)
    this.emit()
  }

  current(): DialogRequest | null {
    return this.queue[0] ?? null
  }

  /** Resolves whatever's at the head with `value` (caller's responsibility
   *  to pass the correct type), then advances the queue. No-op on empty. */
  resolveCurrent(value: unknown): void {
    const head = this.queue.shift()
    if (!head) return
    // Each request kind has its own resolver type but they all accept
    // the union when invoked through this generic entry point.
    ;(head.resolve as (v: unknown) => void)(value)
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  private emit(): void {
    for (const fn of this.subscribers) fn()
  }
}
