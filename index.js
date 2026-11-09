/**
 * Host half of dsh-archived-session-delete.
 *
 * One authenticated exact Fetch route (`POST /api/archived-sessions.delete`)
 * performs the irreversible operation behind the sidebar's archived-session
 * menu: verify the Session is archived, claim write ownership for the whole
 * operation, delete the session-owned log directories children-first, drop the
 * registry archive entry, remove derived projection-cache records, and tell
 * connected Clients the Sessions left the catalog.
 *
 * It deliberately refuses to run while anything still owns or targets the
 * Session (a live writer, background jobs, active scheduled tasks) and it never
 * guesses a storage path: every artifact comes from
 * `sessionPersistence.stat(sessionId).location`.
 */
import {
  DELETE_ROUTE_PATH,
  SessionDeleteFailure,
  classifySessionArtifact,
  inspectSessionArtifact,
  isPersistenceNotFound,
  isPersistenceOwned,
  parseDeleteRequest,
  persistenceFailure,
  removeProjectionCache,
  removeSessionArtifact,
} from './lib/session-delete.js'

/** Stable Cordis plugin name. */
export const name = 'archived-session-delete'

/** Services required before the route can be registered. */
export const inject = ['connection', 'sessionPersistence']

/** Deletion requests currently being processed, keyed by session id. */
const inFlight = new Set()

/** Largest accepted JSON request body; the payload is one session id. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024

/** HTTP status for each stable failure code. */
const STATUS_BY_CODE = {
  'invalid-request': 400,
  'session-not-found': 404,
  'delete-busy': 409,
  'session-not-archived': 409,
  'session-pending': 409,
  'session-in-use': 409,
  'session-jobs-running': 409,
  'session-scheduled': 409,
  'work-check-unavailable': 409,
  'lineage-unavailable': 409,
  'storage-migration-required': 409,
  'storage-unsupported': 409,
  'storage-unexpected-entry': 409,
  'delete-failed': 500,
  'delete-partial': 500,
}

/**
 * Register the delete route on the authenticated `/api` channel.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.connection.fetch.register({
    path: DELETE_ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleDeleteRequest(ctx, request),
  })
}

/**
 * @param {number} status HTTP status.
 * @param {Record<string, unknown>} body JSON-safe response body.
 * @returns {Response} a no-store JSON response.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Read and validate the request payload.
 * @param {Request} request authenticated Fetch request.
 * @returns {Promise<{ sessionId: string }>} validated payload.
 */
async function readPayload(request) {
  // Reject an oversized declared body before decoding it: the /api bridge has
  // already buffered the bytes, but this keeps the handler from materializing a
  // huge string and gives a precise failure instead of a parse error.
  const declaredLength = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new SessionDeleteFailure('invalid-request', 'request body is too large')
  }
  let text
  try {
    text = await request.text()
  } catch (error) {
    throw new SessionDeleteFailure('invalid-request', `request body could not be read: ${messageOf(error)}`)
  }
  if (text.length > MAX_REQUEST_BODY_BYTES) throw new SessionDeleteFailure('invalid-request', 'request body is too large')
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new SessionDeleteFailure('invalid-request', 'request body is not valid JSON')
  }
  return { sessionId: parseDeleteRequest(payload) }
}

/**
 * Handle one authenticated delete request end to end.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {Request} request authenticated Fetch request.
 * @returns {Promise<Response>} the JSON response.
 */
async function handleDeleteRequest(ctx, request) {
  if (request.method !== 'POST') {
    return json(405, { ok: false, code: 'method-not-allowed', message: 'POST is required' })
  }
  let payload
  try {
    payload = await readPayload(request)
  } catch (error) {
    return failureResponse(error)
  }
  const { sessionId } = payload
  if (inFlight.has(sessionId)) {
    return json(409, {
      ok: false,
      code: 'delete-busy',
      message: `a delete for session "${sessionId}" is already running`,
      details: { sessionId },
    })
  }
  inFlight.add(sessionId)
  try {
    return await runDeletion(ctx, sessionId, request.signal)
  } catch (error) {
    if (error instanceof SessionDeleteFailure) return failureResponse(error)
    console.error('[archived-session-delete] unexpected failure:', error)
    return json(500, { ok: false, code: 'delete-failed', message: messageOf(error) })
  } finally {
    inFlight.delete(sessionId)
  }
}

/**
 * @param {unknown} error failure to render.
 * @returns {Response} the mapped JSON response.
 */
function failureResponse(error) {
  if (!(error instanceof SessionDeleteFailure)) {
    return json(500, { ok: false, code: 'delete-failed', message: messageOf(error) })
  }
  const status = STATUS_BY_CODE[error.code] ?? 500
  return json(status, {
    ok: false,
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  })
}

/**
 * Plan, validate, and execute one deletion. Nothing is mutated until the
 * Session is archived, every planned artifact passed inspection, and every
 * work guard passed; each planned write claim is released in the finally.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {string} sessionId requested Session.
 * @param {AbortSignal} signal request lifetime.
 * @returns {Promise<Response>} the JSON response.
 */
async function runDeletion(ctx, sessionId, signal) {
  const persistence = ctx.sessionPersistence
  await assertArchived(ctx, sessionId)
  const nodes = await collectDeletionPlan(ctx, sessionId, signal)
  /** @type {Array<object>} */
  const plans = []
  try {
    for (const node of nodes) plans.push(await planSession(persistence, node, signal))
    // An unarchive between the request and execution cancels the irreversible part.
    await assertArchived(ctx, sessionId)
    await assertNoRunningWork(ctx, plans)
    return await executePlans(ctx, plans)
  } finally {
    for (const plan of plans) await closeHandle(plan)
  }
}

/**
 * Refuse unless the requested Session is in the registry-global archive set.
 * The Client hides the action for unarchived rows; this is the authoritative
 * Host-side gate for stale dialogs, other tabs and direct requests.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {string} sessionId requested Session.
 * @returns {Promise<void>} resolution when the Session is archived.
 */
async function assertArchived(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  let archivedIds
  try {
    archivedIds = registry === undefined ? undefined : registry.archivedSessionIds
  } catch {
    archivedIds = undefined
  }
  if (!Array.isArray(archivedIds) || !archivedIds.includes(sessionId)) {
    throw new SessionDeleteFailure('session-not-archived', `session "${sessionId}" is not archived`, { sessionId })
  }
}

/**
 * Collect the requested Session and its subagent descendants, parents first.
 * Forks carry the lineage field without `origin: 'subagent'` and are independent
 * conversations, so neither a fork nor its subtree is part of this deletion.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {string} sessionId requested Session.
 * @param {AbortSignal} signal request lifetime.
 * @returns {Promise<Array<{ sessionId: string, parentSessionId: string | undefined }>>} deletion nodes.
 */
async function collectDeletionPlan(ctx, sessionId, signal) {
  const nodes = [{ sessionId, parentSessionId: undefined }]
  const seen = new Set([sessionId])
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery === undefined) return nodes
  let trace
  try {
    trace = await sessionQuery.traceSession(sessionId, signal)
  } catch (error) {
    // The absence of the target is established by the persistence probe below;
    // any other lineage failure must not silently narrow the deletion.
    if (isMissingSessionQuery(error)) {
      // The root may be gone while its subagent logs survived an earlier partial
      // removal; the corpus still knows their parent field.
      return await collectDescendantsFromCorpus(sessionQuery, sessionId, signal, nodes, seen)
    }
    throw new SessionDeleteFailure('lineage-unavailable', `cannot trace the subagent lineage: ${messageOf(error)}`, {
      sessionId,
    })
  }
  const walk = (children, parentSessionId) => {
    if (!Array.isArray(children)) return
    for (const node of children) {
      const header = node?.session?.header
      if (header === null || typeof header !== 'object') continue
      if (header.origin !== 'subagent') continue
      const childId = header.id
      if (typeof childId !== 'string' || seen.has(childId)) continue
      seen.add(childId)
      nodes.push({ sessionId: childId, parentSessionId })
      walk(node.descendants, childId)
    }
  }
  walk(trace.descendants, sessionId)
  return nodes
}

/**
 * Find descendant Sessions through the corpus when the root itself is absent,
 * so a retry after a partial removal can still reach leftover subagent logs.
 * @param {{ filterSessions?: Function }} sessionQuery session query service.
 * @param {string} sessionId absent root Session.
 * @param {AbortSignal} signal request lifetime.
 * @param {Array<{ sessionId: string, parentSessionId: string | undefined }>} nodes collected nodes.
 * @param {Set<string>} seen collected ids.
 * @returns {Promise<Array<{ sessionId: string, parentSessionId: string | undefined }>>} deletion nodes.
 */
async function collectDescendantsFromCorpus(sessionQuery, sessionId, signal, nodes, seen) {
  if (typeof sessionQuery.filterSessions !== 'function') return nodes
  const queue = [sessionId]
  while (queue.length > 0) {
    const parentId = queue.shift()
    let records
    try {
      records = await sessionQuery.filterSessions([{ kind: 'parent', values: [parentId] }], signal)
    } catch (error) {
      console.warn('[archived-session-delete] descendant lookup unavailable:', messageOf(error))
      break
    }
    for (const record of records ?? []) {
      const header = record?.header
      if (header === null || typeof header !== 'object') continue
      if (header.origin !== 'subagent') continue
      const childId = header.id
      if (typeof childId !== 'string' || seen.has(childId)) continue
      seen.add(childId)
      nodes.push({ sessionId: childId, parentSessionId: parentId })
      queue.push(childId)
    }
  }
  return nodes
}

/**
 * Inspect one Session and hold its write claim for the rest of the operation.
 * A held claim is the authoritative "nothing is using this Session" probe and
 * keeps a resume/append from reviving a log that is about to be deleted.
 * @param {{ stat: Function, open: Function }} persistence session persistence service.
 * @param {{ sessionId: string, parentSessionId: string | undefined }} node planned node.
 * @param {AbortSignal} signal request lifetime.
 * @returns {Promise<object>} the plan entry (possibly `missing`).
 */
async function planSession(persistence, node, signal) {
  const { sessionId } = node
  let snapshot
  try {
    snapshot = await persistence.stat(sessionId, { signal })
  } catch (error) {
    if (isPersistenceNotFound(error)) return { ...node, missing: true }
    throw persistenceFailure(error, sessionId)
  }
  if (snapshot === undefined) {
    // `stat` also returns undefined for an artifact whose header cannot be
    // interpreted, so confirm absence through a read open instead of assuming it.
    if (await probeAbsentSession(persistence, sessionId, signal)) return { ...node, missing: true }
    throw new SessionDeleteFailure('storage-unsupported', `session "${sessionId}" exists but cannot be inspected`, {
      sessionId,
    })
  }
  if (snapshot.formatStatus === 'migration-required') {
    throw new SessionDeleteFailure(
      'storage-migration-required',
      `session "${sessionId}" still uses a historical storage format`,
      { sessionId },
    )
  }
  if (snapshot.location === undefined || typeof snapshot.location.path !== 'string') {
    // A created-but-never-materialized Session still lives in process; reporting
    // it as gone would unarchive and broadcast a removal for a live entity.
    throw new SessionDeleteFailure('session-pending', `session "${sessionId}" has no durable artifact yet`, {
      sessionId,
    })
  }
  const artifact = classifySessionArtifact(snapshot.location.path)
  let handle
  try {
    handle = await persistence.open(sessionId, 'write', { signal })
  } catch (error) {
    if (isPersistenceNotFound(error)) return { ...node, missing: true }
    if (isPersistenceOwned(error)) {
      throw new SessionDeleteFailure('session-in-use', `session "${sessionId}" is still owned by a live writer`, {
        sessionId,
      })
    }
    throw persistenceFailure(error, sessionId)
  }
  let inspected
  try {
    inspected = await inspectSessionArtifact(artifact)
  } catch (error) {
    await closeHandle({ sessionId, handle })
    throw error
  }
  return { ...node, missing: false, artifact, bytes: inspected.bytes, handle }
}

/**
 * Confirm that an id `stat` could not describe really has no artifact.
 * @param {{ open: Function }} persistence session persistence service.
 * @param {string} sessionId Session to probe.
 * @param {AbortSignal} signal request lifetime.
 * @returns {Promise<boolean>} whether the Session is definitely absent.
 */
async function probeAbsentSession(persistence, sessionId, signal) {
  let handle
  try {
    handle = await persistence.open(sessionId, 'read', { signal })
  } catch (error) {
    if (isPersistenceNotFound(error)) return true
    throw persistenceFailure(error, sessionId)
  }
  await closeHandle({ sessionId, handle })
  return false
}

/**
 * Refuse the deletion while a Session still has running background jobs or an
 * active scheduled task whose target names it (`session` and reserved
 * `new_once` targets both carry a `sessionId`).
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {Array<object>} plans planned deletions.
 * @returns {Promise<void>} resolution when the deletion may proceed.
 */
async function assertNoRunningWork(ctx, plans) {
  const jobs = ctx.get('jobs')
  if (jobs !== undefined) {
    for (const plan of plans) {
      if (plan.missing) continue
      let owned
      try {
        owned = jobs.list(plan.sessionId) ?? []
      } catch (error) {
        throw new SessionDeleteFailure('work-check-unavailable', `cannot inspect background jobs: ${messageOf(error)}`, {
          sessionId: plan.sessionId,
        })
      }
      const running = owned.filter((job) => job.status === 'running' || job.status === 'stopping')
      if (running.length > 0) {
        throw new SessionDeleteFailure('session-jobs-running', `session "${plan.sessionId}" still runs background jobs`, {
          sessionId: plan.sessionId,
          labels: running.map((job) => job.label ?? job.id),
        })
      }
    }
  }
  const schedule = ctx.get('schedule')
  if (schedule === undefined) return
  let catalog
  try {
    catalog = await schedule.catalog()
  } catch (error) {
    throw new SessionDeleteFailure('work-check-unavailable', `cannot inspect scheduled tasks: ${messageOf(error)}`)
  }
  const wanted = new Set(plans.filter((plan) => !plan.missing).map((plan) => plan.sessionId))
  const active = catalog.filter(
    (task) =>
      task.status === 'active'
      && task.target !== null
      && typeof task.target === 'object'
      && task.target.kind !== 'new'
      && wanted.has(task.target.sessionId),
  )
  if (active.length > 0) {
    throw new SessionDeleteFailure('session-scheduled', 'a Session with active scheduled tasks cannot be deleted', {
      sessionId: active[0].target.sessionId,
      titles: active.map((task) => task.title),
    })
  }
}

/**
 * Delete every planned artifact deepest-first, then clean registry/derived state
 * and notify connected Clients. A descendant failure blocks its ancestors, so a
 * retry can still reach the remaining log; removals that already happened are
 * still reflected in the response and on every connected page.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {Array<object>} plans planned deletions, parents first.
 * @returns {Promise<Response>} the JSON response.
 */
async function executePlans(ctx, plans) {
  const registry = ctx.get('workspaceRegistry')
  /** @type {Set<string>} */
  const removed = new Set()
  /** @type {Array<{ sessionId: string, message: string }>} */
  const failures = []
  /** @type {string[]} */
  const skipped = []
  let bytes = 0
  let cacheRemoved = 0

  const parentOf = new Map(plans.map((plan) => [plan.sessionId, plan.parentSessionId]))
  const ancestorsOf = (sessionId) => {
    const chain = []
    let current = parentOf.get(sessionId)
    while (current !== undefined && !chain.includes(current) && chain.length < 64) {
      chain.push(current)
      current = parentOf.get(current)
    }
    return chain
  }
  const blocked = new Set()

  for (const plan of [...plans].reverse()) {
    if (plan.missing) {
      removed.add(plan.sessionId)
      if (await removeProjectionCache(plan.sessionId)) cacheRemoved += 1
      continue
    }
    if (blocked.has(plan.sessionId)) {
      skipped.push(plan.sessionId)
      continue
    }
    try {
      await removeSessionArtifact(plan.artifact)
    } catch (error) {
      failures.push({ sessionId: plan.sessionId, message: messageOf(error) })
      for (const ancestor of ancestorsOf(plan.sessionId)) blocked.add(ancestor)
      continue
    }
    removed.add(plan.sessionId)
    bytes += plan.bytes ?? 0
    if (await removeProjectionCache(plan.sessionId)) cacheRemoved += 1
  }

  for (const plan of plans) {
    if (!removed.has(plan.sessionId)) continue
    if (registry !== undefined) {
      try {
        await registry.unarchiveSession(plan.sessionId)
      } catch (error) {
        console.warn('[archived-session-delete] could not clear the archive entry:', messageOf(error))
      }
    }
    emitSessionRemoved(ctx, plan.sessionId)
  }

  const removedSessionIds = plans.filter((plan) => removed.has(plan.sessionId)).map((plan) => plan.sessionId)
  if (failures.length > 0) {
    return json(500, {
      ok: false,
      code: 'delete-partial',
      message: 'some session artifacts could not be removed',
      details: { failures, removedSessionIds, skippedSessionIds: skipped, bytes },
    })
  }
  return json(200, {
    ok: true,
    sessionId: plans[0]?.sessionId,
    removedSessionIds,
    bytes,
    cacheRemoved,
    alreadyGone: plans.every((plan) => plan.missing),
  })
}

/**
 * Release one held write claim; a failed close never fails the deletion.
 * @param {{ sessionId: string, handle?: { close: Function } }} plan planned entry.
 * @returns {Promise<void>} resolution after close settled.
 */
async function closeHandle(plan) {
  if (plan.handle === undefined) return
  const handle = plan.handle
  plan.handle = undefined
  try {
    await handle.close()
  } catch (error) {
    console.warn(`[archived-session-delete] could not release the write claim for "${plan.sessionId}":`, messageOf(error))
  }
}

/**
 * Announce the removal through the forwarded API Session events so every
 * connected Client drops the row from its catalog.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {string} sessionId removed Session identity.
 * @returns {void}
 */
function emitSessionRemoved(ctx, sessionId) {
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch (error) {
    console.warn('[archived-session-delete] could not announce the removal:', messageOf(error))
  }
}

/** @param {unknown} error @returns {boolean} whether session-query refused an absent Session. */
function isMissingSessionQuery(error) {
  return error !== null && typeof error === 'object' && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
}

/** @param {unknown} error @returns {string} a printable message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
