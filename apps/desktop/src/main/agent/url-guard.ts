/**
 * Pre-fetch URL validation for the web_fetch tool.
 *
 * SSRF posture: only http(s); host must NOT resolve to (or be) a loopback,
 * RFC1918 private, link-local, or 0.0.0.0 address. We block by **literal
 * IP in the URL** — DNS rebinding is not addressed here (would need a
 * lookup-then-connect-with-same-IP pattern that's out of scope for v1).
 *
 * Returned as a discriminated union so callers can pattern-match and we
 * never have to throw from the hot path.
 */

export type UrlCheckResult =
  | { ok: true; url: URL }
  | { ok: false; error: string }

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  '::',
  '::1'
])

export function checkUrl(input: string): UrlCheckResult {
  if (!input || typeof input !== 'string') {
    return { ok: false, error: 'invalid url' }
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, error: 'invalid url' }
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { ok: false, error: `blocked scheme: ${url.protocol}` }
  }
  // `URL` lowercases hostname; IPv6 hostnames are returned in their bracketed
  // form (e.g. `[::1]`) — strip the brackets so the blocked-host set / IP
  // parsing see the literal.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, error: `blocked host (loopback): ${host}` }
  }
  const ipv4 = parseIPv4(host)
  if (ipv4 !== null) {
    const denial = denyIpv4(ipv4)
    if (denial) return { ok: false, error: `blocked host (${denial}): ${host}` }
  }
  // IPv6 literals (other than ::, ::1 above) we don't try to parse for
  // private ranges. v1 keeps coverage to the common cases and rejects ::1
  // explicitly. If a future report shows abuse via v6, tighten here.
  return { ok: true, url }
}

/**
 * Parse a dotted-quad IPv4 string to a 32-bit integer, or null when the
 * input isn't a literal v4 address. Doesn't accept shorthand (e.g. `127.1`)
 * — keeps the SSRF check simple and matches what `URL` exposes.
 */
function parseIPv4(host: string): number | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const parts = m.slice(1).map((s) => Number(s))
  for (const p of parts) {
    if (!Number.isInteger(p) || p < 0 || p > 255) return null
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function inRange(ip: number, cidrStart: string, prefixBits: number): boolean {
  const start = parseIPv4(cidrStart)
  if (start === null) return false
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0
  return (ip & mask) === (start & mask)
}

/**
 * If the v4 address should be blocked, return a short reason. Otherwise null.
 */
function denyIpv4(ip: number): string | null {
  if (inRange(ip, '0.0.0.0', 8)) return 'loopback'
  if (inRange(ip, '127.0.0.0', 8)) return 'loopback'
  if (inRange(ip, '10.0.0.0', 8)) return 'private'
  if (inRange(ip, '192.168.0.0', 16)) return 'private'
  if (inRange(ip, '172.16.0.0', 12)) return 'private'
  if (inRange(ip, '169.254.0.0', 16)) return 'link-local / metadata'
  return null
}
