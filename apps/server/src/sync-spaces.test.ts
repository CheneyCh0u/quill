import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { createSyncSpaceRoutes } from './sync-spaces'

async function freshApp(): Promise<Hono> {
  const dir = await mkdtemp(join(tmpdir(), 'quill-sync-spaces-'))
  const app = new Hono()
  app.route('/api/sync/spaces', createSyncSpaceRoutes(join(dir, 'sync-spaces.json')))
  return app
}

async function req(app: Hono, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      ...(body !== undefined
        ? {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' }
          }
        : {})
    })
  )
}

describe('sync space registry', () => {
  let app: Hono
  beforeEach(async () => {
    app = await freshApp()
  })

  test('GET returns empty list initially', async () => {
    const r = await req(app, 'GET', '/api/sync/spaces')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  test('POST creates a space and GET lists it', async () => {
    const r = await req(app, 'POST', '/api/sync/spaces', {
      name: 'my-notes',
      remotePath: 'my-notes'
    })
    expect(r.status).toBe(200)
    const created = (await r.json()) as {
      id: string
      name: string
      remotePath: string
      createdAt: number
    }
    expect(created.id).toBeTruthy()
    expect(created.name).toBe('my-notes')
    expect(created.remotePath).toBe('my-notes')

    const list = (await (await req(app, 'GET', '/api/sync/spaces')).json()) as unknown[]
    expect(list).toEqual([created])
  })

  test('POST rejects invalid body', async () => {
    const r = await req(app, 'POST', '/api/sync/spaces', { name: '' })
    expect(r.status).toBe(400)
  })

  test('POST rejects duplicate remotePath', async () => {
    await req(app, 'POST', '/api/sync/spaces', { name: 'a', remotePath: 'notes' })
    const r = await req(app, 'POST', '/api/sync/spaces', {
      name: 'b',
      remotePath: 'notes'
    })
    expect(r.status).toBe(409)
  })

  test('POST rejects remotePath escaping vault root', async () => {
    const r = await req(app, 'POST', '/api/sync/spaces', {
      name: 'evil',
      remotePath: '../outside'
    })
    expect(r.status).toBe(400)
  })

  test('DELETE removes a space; unknown id returns 404', async () => {
    const created = (await (
      await req(app, 'POST', '/api/sync/spaces', { name: 'a', remotePath: 'a' })
    ).json()) as { id: string }

    const del = await req(app, 'DELETE', `/api/sync/spaces/${created.id}`)
    expect(del.status).toBe(200)
    expect(await (await req(app, 'GET', '/api/sync/spaces')).json()).toEqual([])

    const again = await req(app, 'DELETE', `/api/sync/spaces/${created.id}`)
    expect(again.status).toBe(404)
  })
})
