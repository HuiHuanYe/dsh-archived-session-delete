import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DELETE_ROUTE_PATH } from '../lib/session-delete.js'
import { apply } from '../index.js'

const ROOT_ID = 'session-root'
const CHILD_ID = 'session-child'
const FORK_ID = 'session-fork'
const FORK_CHILD_ID = 'session-fork-child'

function persistenceError(name, id) {
  const error = new Error(`${name}: ${id}`)
  error.name = name
  return error
}

function queryError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function standardLineage() {
  return [
    {
      session: { header: { id: CHILD_ID, origin: 'subagent', parentSession: ROOT_ID } },
      descendants: [],
    },
  ]
}

function forkLineage() {
  return [
    ...standardLineage(),
    {
      session: { header: { id: FORK_ID, parentSession: ROOT_ID } },
      descendants: [
        {
          session: { header: { id: FORK_CHILD_ID, origin: 'subagent', parentSession: FORK_ID } },
          descendants: [],
        },
      ],
    },
  ]
}

async function makeWorld(options = {}) {
  const {
    owned = new Set(),
    missing = new Set(),
    pending = new Set(),
    corruptRead = new Set(),
    unexpected = new Map(),
    schedule = [],
    jobs = new Map(),
    jobsThrow = false,
    scheduleThrow = false,
    lineage = standardLineage(),
    lineageError = null,
    archived = [ROOT_ID, CHILD_ID],
  } = options
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-route-home-'))
  const projectRoot = path.join(home, 'sessions', '--project--')
  const locations = new Map()
  for (const id of [ROOT_ID, CHILD_ID, FORK_ID, FORK_CHILD_ID]) {
    if (missing.has(id) || pending.has(id) || corruptRead.has(id)) continue
    if (id === FORK_ID || id === FORK_CHILD_ID) continue
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

  const openHandles = []
  const persistence = {
    async stat(id, options) {
      if (missing.has(id) || corruptRead.has(id)) return undefined
      if (pending.has(id)) return { header: { id }, formatStatus: 'current' }
      const location = locations.get(id)
      if (location === undefined) throw persistenceError('SessionPersistenceNotFoundError', id)
      return { header: { id }, formatStatus: 'current', location: { kind: 'jsonl', path: location } }
    },
    async open(id, access) {
      if (missing.has(id)) throw persistenceError('SessionPersistenceNotFoundError', id)
      if (corruptRead.has(id)) throw persistenceError('SessionPersistenceCorruptionError', id)
      if (access === 'write' && owned.has(id)) throw persistenceError('SessionAlreadyOwnedError', id)
      const handle = {
        closed: false,
        async close() {
          handle.closed = true
        },
      }
      openHandles.push(handle)
      return handle
    },
  }

  const corpus = []
  const collectCorpus = (children, parentId) => {
    for (const node of children) {
      const header = node?.session?.header
      if (header === null || typeof header !== 'object') continue
      corpus.push({ header, parentId })
      collectCorpus(node.descendants, header.id)
    }
  }
  collectCorpus(lineage, ROOT_ID)

  const services = {
    sessionQuery: {
      async traceSession(id) {
        if (lineageError !== null) throw lineageError
        if (missing.has(id)) throw queryError('SESSION_QUERY_SESSION_NOT_FOUND', `session "${id}" not found`)
        return {
          target: { header: { id } },
          ancestors: [],
          root: { header: { id } },
          complete: true,
          descendants: lineage,
        }
      },
      async filterSessions(filters) {
        const parents = filters?.[0]?.kind === 'parent' ? filters[0].values : []
        return corpus
          .filter((entry) => parents.includes(entry.parentId) && !missing.has(entry.header.id))
          .map((entry) => ({ header: entry.header }))
      },
    },
    workspaceRegistry: {
      get archivedSessionIds() {
        return archived
      },
      async unarchiveSession() {},
    },
    jobs: {
      list: (id) => {
        if (jobsThrow) throw new Error('job registry unavailable')
        return jobs.get(id) ?? []
      },
    },
    schedule: {
      catalog: async () => {
        if (scheduleThrow) throw new Error('schedule registry unavailable')
        return schedule
      },
    },
  }

  return { home, projectRoot, locations, persistence, services, openHandles, archived }
}

function makeContext(world, { unarchived = [], events = [] } = {}) {
  let route
  const registry = world.services.workspaceRegistry
  world.services.workspaceRegistry = {
    get archivedSessionIds() {
      return registry.archivedSessionIds
    },
    async unarchiveSession(sessionId) {
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

async function callDelete(world, route, sessionId = ROOT_ID) {
  const response = await withEnvironment(world.home, () => route.fetch(deleteRequest(sessionId)))
  return { response, body: await response.json() }
}

async function cleanup(world) {
  await fs.rm(world.home, { recursive: true, force: true })
}

function assertHandlesClosed(world) {
  assert.ok(world.openHandles.every((handle) => handle.closed), 'every write claim must be released')
}

test('the Host route deletes the archived session, its subagent log, cache and archive entry', async () => {
  const world = await makeWorld()
  const { ctx, getRoute, unarchived, events } = makeContext(world)
  apply(ctx)
  const route = getRoute()
  assert.equal(route.path, DELETE_ROUTE_PATH)
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')

  const { response, body } = await callDelete(world, route)
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
  assertHandlesClosed(world)
  await cleanup(world)
})

test('a session that is not archived is refused without touching storage', async () => {
  const world = await makeWorld({ archived: [] })
  const { ctx, getRoute, events } = makeContext(world)
  apply(ctx)
  const { response, body } = await callDelete(world, getRoute())
  assert.equal(response.status, 409)
  assert.equal(body.code, 'session-not-archived')
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  assert.equal(events.length, 0)
  assert.equal(world.openHandles.length, 0, 'nothing was inspected or claimed')
  await cleanup(world)
})

test('a session with a live writer is refused and nothing is removed', async () => {
  const world = await makeWorld({ owned: new Set([ROOT_ID]) })
  const { ctx, getRoute, events } = makeContext(world)
  apply(ctx)
  const { response, body } = await callDelete(world, getRoute())
  assert.equal(response.status, 409)
  assert.equal(body.code, 'session-in-use')
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  assert.equal(events.length, 0)
  await cleanup(world)
})

test('a created-but-unmaterialized session is refused instead of reported gone', async () => {
  const world = await makeWorld({ pending: new Set([ROOT_ID]) })
  const { ctx, getRoute, events } = makeContext(world)
  apply(ctx)
  const { response, body } = await callDelete(world, getRoute())
  assert.equal(response.status, 409)
  assert.equal(body.code, 'session-pending')
  assert.equal(events.length, 0)
  await cleanup(world)
})

test('a session artifact whose header cannot be interpreted is refused, not reported gone', async () => {
  const world = await makeWorld({ corruptRead: new Set([ROOT_ID]) })
  const { ctx, getRoute, events } = makeContext(world)
  apply(ctx)
  const { response, body } = await callDelete(world, getRoute())
  assert.equal(response.status, 409)
  assert.equal(body.code, 'storage-unsupported')
  assert.equal(events.length, 0)
  await cleanup(world)
})

test('forks are independent conversations and are never deleted with their parent', async () => {
  const world = await makeWorld({ lineage: forkLineage() })
  const { ctx, getRoute } = makeContext(world)
  apply(ctx)
  const { response, body } = await callDelete(world, getRoute())
  assert.equal(response.status, 200)
  assert.deepEqual(body.removedSessionIds, [ROOT_ID, CHILD_ID])
  assert.ok(!body.removedSessionIds.includes(FORK_ID))
  assert.ok(!body.removedSessionIds.includes(FORK_CHILD_ID))
  await cleanup(world)
})

test('a lineage failure refuses the whole deletion instead of orphaning descendants', async () => {
  const world = await makeWorld({ lineageError: new Error('lineage cycle') })
  const { ctx, getRoute } = makeContext(world)
  apply(ctx)
  const { response, body } = await callDelete(world, getRoute())
  assert.equal(response.status, 409)
  assert.equal(body.code, 'lineage-unavailable')
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  await cleanup(world)
})

test('a session with an active scheduled task is refused', async () => {
  const world = await makeWorld({
    schedule: [{ id: 'task-1', title: 'nightly', status: 'active', target: { kind: 'session', sessionId: ROOT_ID } }],
  })
  const { ctx, getRoute } = makeContext(world)
  apply(ctx)
  const { response, body } = await callDelete(world, getRoute())
  assert.equal(response.status, 409)
  assert.equal(body.code, 'session-scheduled')
  assert.equal(body.details.titles[0], 'nightly')
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  await cleanup(world)
})

test('an active task with a reserved new_once target is also refused', async () => {
  const world = await makeWorld({
    schedule: [{ id: 'task-2', title: 'later', status: 'active', target: { kind: 'new_once', sessionId: ROOT_ID } }],
  })
  const { ctx, getRoute } = makeContext(world)
  apply(ctx)
  const { response, body } = await callDelete(world, getRoute())
  assert.equal(response.status, 409)
  assert.equal(body.code, 'session-scheduled')
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  await cleanup(world)
})

test('a session with running background jobs is refused', async () => {
  const world = await makeWorld({
    jobs: new Map([[ROOT_ID, [{ id: 'bash-1', label: 'pnpm test', status: 'running' }]]]),
  })
  const { ctx, getRoute } = makeContext(world)
  apply(ctx)
  const { response, body } = await callDelete(world, getRoute())
  assert.equal(response.status, 409)
  assert.equal(body.code, 'session-jobs-running')
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  await cleanup(world)
})

test('work catalogs that cannot be read fail closed', async () => {
  for (const options of [{ jobsThrow: true }, { scheduleThrow: true }]) {
    const world = await makeWorld(options)
    const { ctx, getRoute } = makeContext(world)
    apply(ctx)
    const { response, body } = await callDelete(world, getRoute())
    assert.equal(response.status, 409)
    assert.equal(body.code, 'work-check-unavailable')
    assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
    assertHandlesClosed(world)
    await cleanup(world)
  }
})

test('an unexpected file inside the session directory refuses the deletion', async () => {
  const world = await makeWorld({ unexpected: new Map([[ROOT_ID, ['notes.txt']]]) })
  const { ctx, getRoute } = makeContext(world)
  apply(ctx)
  const { response, body } = await callDelete(world, getRoute())
  assert.equal(response.status, 409)
  assert.equal(body.code, 'storage-unexpected-entry')
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  assertHandlesClosed(world)
  await cleanup(world)
})

test('an already missing root is reported as gone and its surviving subagent log is still removed', async () => {
  const world = await makeWorld({ missing: new Set([ROOT_ID]) })
  const { ctx, getRoute, unarchived, events } = makeContext(world)
  apply(ctx)
  const { response, body } = await callDelete(world, getRoute())
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.alreadyGone, false)
  assert.deepEqual(body.removedSessionIds, [ROOT_ID, CHILD_ID])
  assert.deepEqual(unarchived, [ROOT_ID, CHILD_ID])
  assert.deepEqual(events.map((event) => event.args[0]), [ROOT_ID, CHILD_ID])
  await assert.rejects(fs.lstat(path.dirname(world.locations.get(CHILD_ID))), { code: 'ENOENT' })
  await cleanup(world)
})

test('a fully missing session is reported as gone and its stale archive entry is cleared', async () => {
  const world = await makeWorld({ missing: new Set([ROOT_ID, CHILD_ID]) })
  const { ctx, getRoute, unarchived, events } = makeContext(world)
  apply(ctx)
  const { response, body } = await callDelete(world, getRoute())
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.alreadyGone, true)
  assert.deepEqual(body.removedSessionIds, [ROOT_ID])
  assert.deepEqual(unarchived, [ROOT_ID])
  assert.deepEqual(events.map((event) => event.args[0]), [ROOT_ID])
  await cleanup(world)
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
  await cleanup(world)
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
  await cleanup(world)
})

test('an oversized declared request body is rejected before it is read', async () => {
  const world = await makeWorld()
  const { ctx, getRoute } = makeContext(world)
  apply(ctx)
  let read = false
  const oversized = {
    method: 'POST',
    headers: new Headers({ 'content-length': String(10 * 1024 * 1024) }),
    text: async () => {
      read = true
      return JSON.stringify({ sessionId: ROOT_ID })
    },
    signal: new AbortController().signal,
  }
  const response = await withEnvironment(world.home, () => getRoute().fetch(oversized))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'invalid-request')
  assert.equal(read, false, 'the body is not decoded when content-length already exceeds the cap')
  assert.equal((await fs.lstat(world.locations.get(ROOT_ID))).isFile(), true)
  await cleanup(world)
})
