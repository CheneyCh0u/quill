import { Hono } from 'hono'
import { z } from 'zod'
import { setCookie, deleteCookie } from 'hono/cookie'
import {
  signSession,
  verifyPassword,
  requireSession,
  SESSION_COOKIE_NAME
} from './auth'

const LoginSchema = z.object({ password: z.string().min(1) })

export type AuthConfig = {
  passwordHash: string
  sessionSecret: string
  sessionTtlDays: number
}

export function createAuthRoutes(config: AuthConfig): Hono {
  const app = new Hono()

  app.post('/login', async (c) => {
    const parsed = LoginSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    const ok = await verifyPassword(parsed.data.password, config.passwordHash)
    if (!ok) return c.json({ error: 'invalid password' }, 401)
    const token = await signSession(config.sessionSecret, config.sessionTtlDays)
    // Set the cookie for browser clients AND return the token in the body
    // so cross-origin clients (Electron desktop renderer) can stash it
    // and send `Authorization: Bearer <token>` on subsequent requests —
    // SameSite=Lax cookies don't survive a file://-to-https jump.
    setCookie(c, SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: config.sessionTtlDays * 24 * 60 * 60
    })
    return c.json({ ok: true, token })
  })

  app.post('/logout', async (c) => {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/me', requireSession(config.sessionSecret), async (c) =>
    c.json({ authenticated: true })
  )

  return app
}
