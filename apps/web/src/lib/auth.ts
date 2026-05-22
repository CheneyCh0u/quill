import { UnauthorizedError } from '@quill/vault-adapter'

export async function login(password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  })
  if (res.status === 401) throw new Error('密码错误')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`登录失败：${res.status} ${body}`)
  }
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
}

/** Returns true if the cookie is present and accepted, false otherwise. */
export async function isAuthenticated(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' })
    return res.ok
  } catch {
    return false
  }
}

export { UnauthorizedError }
