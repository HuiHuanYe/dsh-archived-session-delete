/**
 * Host half of dsh-archived-session-delete.
 *
 * One authenticated exact Fetch route (`POST /api/archived-sessions.delete`)
 * performs the irreversible operation behind the sidebar's archived-session
 * menu: claim write ownership, delete the session-owned log directory, drop the
 * registry archive entry, remove the derived projection-cache record, and tell
 * connected Clients the Session left the catalog.
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
  'session-in-use': 409,
  'session-jobs-running': 409,
  'session-scheduled': 409,
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
 * Plan, validate, and execute one deletion. Nothing is mutated until every
 * planned artifact passed inspection and every guard passed.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {string} sessionId requested Session.
 * @param {AbortSignal} signal request lifetime.
 * @returns {Promise<Response>} the JSON response.
 */
async function runDeletion(ctx, sessionId, signal) {
  const persistence = ctx.sessionPersistence
  const ids = await collectDeletionIds(ctx, sessionId, signal)
  /** @type {Array<{ sessionId: string, missing: boolean, artifact?: object, bytes?: number }>} */
  const plans = []
  for (const id of ids) {
    const plan = await inspectSession(ctx, persistence, id, signal)
    plans.push(plan)
  }
  await assertNoRunningWork(ctx, plans)
  return executePlans(ctx, plans)
}

/**
 * Collect the requested Session and its known subagent descendants, because a
 * deleted parent's descendant logs are unreachable afterwards.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {string} sessionId requested Session.
 * @param {AbortSignal} signal request lifetime.
 * @returns {Promise<string[]>} unique session ids in deletion order.
 */
async function collectDeletionIds(ctx, sessionId, signal) {
  const ids = [sessionId]
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery === undefined) return ids
  try {
    const trace = await sessionQuery.traceSession(sessionId, signal)
    const walk = (nodes) => {
      for (const node of nodes) {
        ids.push(node.session.header.id)
        walk(node.descendants)
      }
    }
    walk(trace.descendants)
  } catch (error) {
    // An absent target is reported by the persistence snapshot below; any other
    // tracing failure only narrows the deletion to the requested Session.
    if (!isMissingSessionQuery(error)) {
      console.warn('[archived-session-delete] subagent lineage unavailable:', messageOf(error))
    }
  }
  return [...new Set(ids)]
}

/** @param {unknown} error @returns {boolean} whether session-query refused an absent Session. */
function isMissingSessionQuery(error) {
  return error !== null && typeof error === 'object' && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
}

/**
 * Inspect one Session and, when it exists, claim and release write ownership so
 * a live writer or another process is detected before any deletion begins.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {{ stat: Function, open: Function }} persistence session persistence service.
 * @param {string} sessionId Session to inspect.
 * @param {AbortSignal} signal request lifetime.
 * @returns {Promise<{ sessionId: string, missing: boolean, artifact?: object, bytes?: number }>} the plan.
 */
async function inspectSession(ctx, persistence, sessionId, signal) {
  let snapshot
  try {
    snapshot = await persistence.stat(sessionId, { signal })
  } catch (error) {
    if (isPersistenceNotFound(error)) return { sessionId, missing: true }
    throw persistenceFailure(error, sessionId)
  }
  if (snapshot === undefined) return { sessionId, missing: true }
  if (snapshot.formatStatus === 'migration-required') {
    throw new SessionDeleteFailure(
      'storage-migration-required',
      `session "${sessionId}" still uses a historical storage format`,
      { sessionId },
    )
  }
  if (snapshot.location === undefined || typeof snapshot.location.path !== 'string') {
    // A created-but-never-materialized Session has no artifact to delete.
    return { sessionId, missing: true }
  }
  const artifact = classifySessionArtifact(snapshot.location.path)
  const inspected = await inspectSessionArtifact(artifact)
  await claimWriteOwnership(persistence, sessionId, signal)
  return { sessionId, missing: false, artifact, bytes: inspected.bytes }
}

/**
 * Open and promptly close a write handle. The backend's single-writer claim is
 * the authoritative "is anything still using this Session" probe.
 * @param {{ open: Function }} persistence session persistence service.
 * @param {string} sessionId Session to claim.
 * @param {AbortSignal} signal request lifetime.
 * @returns {Promise<void>} resolution after ownership was claimed and released.
 */
async function claimWriteOwnership(persistence, sessionId, signal) {
  let handle
  try {
    handle = await persistence.open(sessionId, 'write', { signal })
  } catch (error) {
    if (isPersistenceNotFound(error)) {
      throw new SessionDeleteFailure('session-not-found', `session "${sessionId}" disappeared during deletion`, { sessionId })
    }
    if (isPersistenceOwned(error)) {
      throw new SessionDeleteFailure('session-in-use', `session "${sessionId}" is still owned by a live writer`, { sessionId })
    }
    throw persistenceFailure(error, sessionId)
  }
  try {
    await handle.close()
  } catch (error) {
    console.warn('[archived-session-delete] could not release the write claim:', messageOf(error))
  }
}

/**
 * Refuse the deletion while a Session still has running background jobs or an
 * active scheduled task targeting it.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {Array<{ sessionId: string, missing: boolean }>} plans planned deletions.
 * @returns {Promise<void>} resolution when the deletion may proceed.
 */
async function assertNoRunningWork(ctx, plans) {
  const jobs = ctx.get('jobs')
  if (jobs !== undefined) {
    for (const plan of plans) {
      let owned = []
      try {
        owned = jobs.list(plan.sessionId) ?? []
      } catch {
        continue
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
    console.warn('[archived-session-delete] scheduled-task catalog unavailable:', messageOf(error))
    return
  }
  const wanted = new Set(plans.map((plan) => plan.sessionId))
  const active = catalog.filter(
    (task) => task.status === 'active' && task.target?.kind === 'session' && wanted.has(task.target.sessionId),
  )
  if (active.length > 0) {
    throw new SessionDeleteFailure('session-scheduled', 'a Session with active scheduled tasks cannot be deleted', {
      sessionId: active[0].target.sessionId,
      titles: active.map((task) => task.title),
    })
  }
}

/**
 * Delete every planned artifact, then clean registry/derived state and notify
 * connected Clients. Per-artifact removal is best-effort: the response reports
 * partial failures while every successful removal still updates the UI.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {Array<{ sessionId: string, missing: boolean, artifact?: object, bytes?: number }>} plans planned deletions.
 * @returns {Promise<Response>} the JSON response.
 */
async function executePlans(ctx, plans) {
  const registry = ctx.get('workspaceRegistry')
  /** @type {string[]} */
  const removed = []
  /** @type {Array<{ sessionId: string, message: string }>} */
  const failures = []
  /** @type {string[]} */
  const warnings = []
  let bytes = 0
  let cacheRemoved = 0

  for (const plan of plans) {
    if (plan.missing) {
      removed.push(plan.sessionId)
      continue
    }
    let cleanupWarning
    try {
      cleanupWarning = await removeSessionArtifact(plan.artifact)
    } catch (error) {
      failures.push({ sessionId: plan.sessionId, message: messageOf(error) })
      continue
    }
    if (cleanupWarning !== undefined) {
      warnings.push(`${plan.sessionId}: ${cleanupWarning}`)
      console.warn('[archived-session-delete]', cleanupWarning)
    }
    bytes += plan.bytes ?? 0
    removed.push(plan.sessionId)
    if (await removeProjectionCache(plan.sessionId)) cacheRemoved += 1
  }

  for (const plan of plans) {
    if (!plan.missing) continue
    if (await removeProjectionCache(plan.sessionId)) cacheRemoved += 1
  }

  for (const sessionId of removed) {
    if (registry !== undefined) {
      try {
        await registry.unarchiveSession(sessionId)
      } catch (error) {
        console.warn('[archived-session-delete] could not clear the archive entry:', messageOf(error))
      }
    }
    emitSessionRemoved(ctx, sessionId)
  }

  if (failures.length > 0) {
    return json(500, {
      ok: false,
      code: 'delete-partial',
      message: 'some session artifacts could not be removed',
      details: {
        failures,
        removedSessionIds: removed,
        bytes,
        ...(warnings.length === 0 ? {} : { warnings }),
      },
    })
  }
  return json(200, {
    ok: true,
    sessionId: plans[0]?.sessionId,
    removedSessionIds: removed,
    bytes,
    cacheRemoved,
    alreadyGone: plans.every((plan) => plan.missing),
    ...(warnings.length === 0 ? {} : { warnings }),
  })
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

/** @param {unknown} error @returns {string} a printable message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
