import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DELETE_ROUTE_PATH } from '../lib/session-delete.js'
import { apply } from '../index.js'

const ROOT_ID = 'session-root'
const CHILD_ID = 'session-child'

function persistenceError(name, id) {
  const error = new Error(`${name}: ${id}`)
  error.name = name
  return error
}

async function makeWorld({ owned = new Set(), unexpected = new Map(), schedule = [], jobs = new Map(), missing = new Set() } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-route-home-'))
  const projectRoot = path.join(home, 'sessions', '--project--')
  const locations = new Map()
  for (const id of [ROOT_ID, CHILD_ID]) {
    if (missing.has(id)) continue
    const location = path.join(projectRoot, id, 'session.v4.jsonl.zstd')
    await fs.mkdir(path.dirname(location), { recursive: true })
    await fs.writeFile(location, `log of ${id}`)
    for (const extra of unexpected.get(id) ?? []) await fs.writeFile(path.join(projectRoot, id, extra), 'extra')
    locations.set(id, location)
  }
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')
  await fs.mkdir(cacheDir, { recursive: true })
  await fs.writeFile(
    path.join(cacheDir, `${ROOT_ID}.json`),
    JSON.stringify({ version: 7, record: { identity: { formatVersion: 4 }, rows: {} } }),
  )

  const persistence = {
    async stat(id) {
      if (missing.has(id)) return undefined
      const location = locations.get(id)
      if (location === undefined) throw persistenceError('SessionPersistenceNotFoundError', id)
      return { header: { id }, formatStatus: 'current', location: { kind: 'jsonl', path: location } }
    },
    async open(id) {
      if (missing.has(id)) throw persistenceError('SessionPersistenceNotFoundError', id)
      if (owned.has(id)) throw persistenceError('SessionAlreadyOwnedError', id)
      return { close: async () => {} }
    },
  }

  const services = {
    sessionQuery: {
      async traceSession(id) {
        if (id !== ROOT_ID) throw new Error('not traced')
        return {
          target: { header: { id: ROOT_ID } },
          ancestors: [],
          root: { header: { id: ROOT_ID } },
          complete: true,
          descendants: [{ session: { header: { id: CHILD_ID } }, descendants: [] }],
        }
      },
    },
    workspaceRegistry: { unarchiveSession: async () => {} },
    jobs: { list: (id) => jobs.get(id) ?? [] },
    schedule: { catalog: async () => schedule },
  }

  return { home, projectRoot, locations, persistence, services, owned, missing }
}

function makeContext(world, { unarchived = [], events = [] } = {}) {
  let route
  world.services.workspaceRegistry = {
    unarchiveSession: async (sessionId) => {
      unarchived.push(sessionId)
    },
  }
  const ctx = {
    connection: { fetch: { register: (registered) => { route = registered; return () => {} } } },
    sessionPersistence: world.persistence,
    get: (name) => world.services[name],
    emit: (name, ...args) => {
      events.push({ name, args })
    },
    effect: (callback) => {
      callback()
      return () => {}
    },
  }
  return { ctx, getRoute: () => route, unarchived, events }
}

function deleteRequest(sessionId = ROOT_ID) {
  return new Request(`http://127.0.0.1:3000${DELETE_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
}

async function withEnvironment(home, operation) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await operation()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

test('the Host route deletes the archived session, its subagent log, cache and archive entry', async () => {
  const world = await makeWorld()
  const { ctx, getRoute, unarchived, events } = makeContext(world)
  apply(ctx)
  const route = getRoute()
  assert.equal(route.path, DELETE_ROUTE_PATH)
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')

  const response = await withEnvironment(world.home, () => route.fetch(deleteRequest()))
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.removedSessionIds, [ROOT_ID, CHILD_ID])
  assert.equal(body.bytes, 'log of session-root'.length + 'log of session-child'.length)
  assert.equal(body.cacheRemoved, 1)
  await assert.rejects(fs.lstat(path.dirname(world.locations.get(ROOT_ID))), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.dirname(world.locations.get(CHILD_ID))), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(world.home, 'storages', 'session_projcache', 'sessions', `${ROOT_ID}.json`)), { code: 'ENOENT' })
  assert.deepEqual(unarchived, [ROOT_ID, CHILD_ID])
  assert.deepEqual(events.map((event) => event.name), ['api-session/removed', 'api-session/removed'])
  assert.deepEqual(events.map((event) => event.args[0]), [ROOT_ID, CHILD_ID])
  await fs.rm(world.home, { recursive: true, force: true })
})

test('a session with a live writer is refused and nothing is removed', async () => {
  const world = await makeWorld({ owned: new Set([ROOT_ID]) })
  const { ctx, getRoute, events } = makeContext(world)
  apply(ctx)
  const response = await withEnvironment(world.home, () => getRoute().fetch(deleteRequest()))
  const body = await response.json()
  assert.equal(response.status, 409)
  assert.equal(body.code, 'session-in-use')
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  assert.equal(events.length, 0)
  await fs.rm(world.home, { recursive: true, force: true })
})

test('a session with an active scheduled task is refused', async () => {
  const world = await makeWorld({
    schedule: [{ id: 'task-1', title: 'nightly', status: 'active', target: { kind: 'session', sessionId: ROOT_ID } }],
  })
  const { ctx, getRoute } = makeContext(world)
  apply(ctx)
  const response = await withEnvironment(world.home, () => getRoute().fetch(deleteRequest()))
  const body = await response.json()
  assert.equal(response.status, 409)
  assert.equal(body.code, 'session-scheduled')
  assert.equal(body.details.titles[0], 'nightly')
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  await fs.rm(world.home, { recursive: true, force: true })
})

test('a session with running background jobs is refused', async () => {
  const world = await makeWorld({
    jobs: new Map([[ROOT_ID, [{ id: 'bash-1', label: 'pnpm test', status: 'running' }]]]),
  })
  const { ctx, getRoute } = makeContext(world)
  apply(ctx)
  const response = await withEnvironment(world.home, () => getRoute().fetch(deleteRequest()))
  const body = await response.json()
  assert.equal(response.status, 409)
  assert.equal(body.code, 'session-jobs-running')
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  await fs.rm(world.home, { recursive: true, force: true })
})

test('an unexpected file inside the session directory refuses the deletion', async () => {
  const world = await makeWorld({ unexpected: new Map([[ROOT_ID, ['notes.txt']]]) })
  const { ctx, getRoute } = makeContext(world)
  apply(ctx)
  const response = await withEnvironment(world.home, () => getRoute().fetch(deleteRequest()))
  const body = await response.json()
  assert.equal(response.status, 409)
  assert.equal(body.code, 'storage-unexpected-entry')
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  await fs.rm(world.home, { recursive: true, force: true })
})

test('an already missing session is reported as gone and its stale archive entry is cleared', async () => {
  const world = await makeWorld({ missing: new Set([ROOT_ID, CHILD_ID]) })
  const { ctx, getRoute, unarchived, events } = makeContext(world)
  apply(ctx)
  const response = await withEnvironment(world.home, () => getRoute().fetch(deleteRequest()))
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.alreadyGone, true)
  assert.deepEqual(body.removedSessionIds, [ROOT_ID, CHILD_ID])
  assert.deepEqual(unarchived, [ROOT_ID, CHILD_ID])
  assert.deepEqual(events.map((event) => event.args[0]), [ROOT_ID, CHILD_ID])
  await fs.rm(world.home, { recursive: true, force: true })
})

test('invalid requests are rejected without touching storage', async () => {
  const world = await makeWorld()
  const { ctx, getRoute } = makeContext(world)
  apply(ctx)
  const route = getRoute()

  const malformed = new Request(`http://127.0.0.1:3000${DELETE_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  })
  const malformedResponse = await withEnvironment(world.home, () => route.fetch(malformed))
  assert.equal(malformedResponse.status, 400)
  assert.equal((await malformedResponse.json()).code, 'invalid-request')

  const badId = new Request(`http://127.0.0.1:3000${DELETE_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: '../../etc/passwd' }),
  })
  const badIdResponse = await withEnvironment(world.home, () => route.fetch(badId))
  assert.equal(badIdResponse.status, 400)

  const wrongMethod = await withEnvironment(world.home, () =>
    route.fetch(new Request(`http://127.0.0.1:3000${DELETE_ROUTE_PATH}`, { method: 'GET' })),
  )
  assert.equal(wrongMethod.status, 405)
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  await fs.rm(world.home, { recursive: true, force: true })
})

test('concurrent deletions of one session are rejected as busy', async () => {
  // The first request blocks inside its first stat call, so the second arrives while it is in flight.
  const world = await makeWorld()
  const originalStat = world.persistence.stat.bind(world.persistence)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let statCalls = 0
  world.persistence.stat = async (id) => {
    statCalls += 1
    if (statCalls === 1) await gate
    return originalStat(id)
  }
  const { ctx, getRoute } = makeContext(world)
  apply(ctx)
  const route = getRoute()
  const first = withEnvironment(world.home, () => route.fetch(deleteRequest()))
  await new Promise((resolve) => setImmediate(resolve))
  const second = await withEnvironment(world.home, () => route.fetch(deleteRequest()))
  const secondBody = await second.json()
  assert.equal(second.status, 409)
  assert.equal(secondBody.code, 'delete-busy')
  release()
  const firstResponse = await first
  assert.equal(firstResponse.status, 200)
  await fs.rm(world.home, { recursive: true, force: true })
})
