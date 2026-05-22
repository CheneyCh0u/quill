import bcrypt from 'bcryptjs'
import { SignJWT, jwtVerify } from 'jose'
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'

const SESSION_COOKIE = 'quill-session'
const ALG = 'HS256'

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash)
  } catch {
    return false
  }
}

/**
 * Sign a session JWT. Subject is hardcoded — single-user deployment, so
 * sub doesn't carry identity, it's just there for shape conformance.
 * ttlDays of 0 produces an effectively-expired token (useful for tests).
 */
export async function signSession(secret: string, ttlDays: number): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject('user')
    .setIssuedAt()
    .setExpirationTime(`${ttlDays}d`)
    .sign(key)
}

export type SessionPayload = { sub: string }

export async function verifySession(
  secret: string,
  token: string
): Promise<SessionPayload | null> {
  try {
    const key = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(token, key, { algorithms: [ALG] })
    if (typeof payload.sub !== 'string') return null
    return { sub: payload.sub }
  } catch {
    return null
  }
}

/** Pull the bearer token out of an Authorization header, or null. */
function extractBearer(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header)
  return m ? m[1] : null
}

/**
 * Hono middleware: rejects unauthenticated requests with 401. Accepts the
 * session JWT via EITHER:
 *  - the `quill-session` httpOnly cookie (web client, same-origin)
 *  - an `Authorization: Bearer <token>` header (desktop client, cross-
 *    origin and unable to receive SameSite=Lax cookies)
 *
 * The two paths use the same JWT under the hood — only the transport
 * differs.
 */
export function requireSession(secret: string): MiddlewareHandler {
  return async (c, next) => {
    const token =
      extractBearer(c.req.header('Authorization')) ?? getCookie(c, SESSION_COOKIE)
    if (!token) return c.json({ error: 'unauthenticated' }, 401)
    const session = await verifySession(secret, token)
    if (!session) return c.json({ error: 'unauthenticated' }, 401)
    c.set('session', session)
    return next()
  }
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE
