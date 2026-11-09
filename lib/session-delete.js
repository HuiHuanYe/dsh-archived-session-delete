/**
 * Durable-storage helpers for the archived-session-delete plugin.
 *
 * The Host route must remove exactly one session-owned artifact directory and
 * nothing else. `sessionPersistence.stat(id).location` is the authoritative
 * per-session artifact path, so every deletion is derived from it and then
 * re-validated structurally: a current-format JSONL generation inside a
 * directory that contains only session generations and the writer lock. Any
 * unexpected entry refuses the deletion instead of deleting unknown data.
 *
 * This module is deliberately free of Cordis imports so it can be unit-tested
 * with `node --test`.
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Absolute, authenticated Fetch route the Host half registers. */
export const DELETE_ROUTE_PATH = '/api/archived-sessions.delete'
/** Document-relative form the browser addresses. */
export const DELETE_ROUTE = DELETE_ROUTE_PATH.slice(1)

/** A Session id is a single opaque path-safe segment. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
/** One current or historical JSONL generation file inside a session directory. */
const ARTIFACT_FILE_PATTERN = /^session(?:\.[A-Za-z0-9_-]+)*\.jsonl(?:\.zstd)?$/u
/** The single-writer lock file a POSIX backend may leave beside the log. */
const LOCK_FILE_PATTERN = /^session\.lock$/u
/** One escaped session-id directory segment (ids are injectively escaped). */
const ARTIFACT_DIRECTORY_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/u
/** Storage-domain unit that owns the per-session projection cache records. */
const PROJECTION_CACHE_UNIT = 'session_projcache'
/** Refuse to read an implausibly large cache record into memory. */
const MAX_CACHE_RECORD_BYTES = 8 * 1024 * 1024

/** One structured refusal the Host route reports to the browser. */
export class SessionDeleteFailure extends Error {
  /**
   * @param {string} code stable machine code the Client localizes.
   * @param {string} message diagnostic for logs and the fallback text.
   * @param {Record<string, unknown> | undefined} details optional structured payload.
   */
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'SessionDeleteFailure'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/**
 * Validate one untrusted request payload.
 * @param {unknown} payload parsed JSON body.
 * @returns {string} the accepted session id.
 */
export function parseDeleteRequest(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SessionDeleteFailure('invalid-request', 'request payload must be a JSON object')
  }
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionDeleteFailure('invalid-request', 'sessionId must be a single plain session id')
  }
  return sessionId
}

/**
 * Validate the artifact location one persistence snapshot reported.
 * @param {unknown} locationPath `SessionPersistenceSnapshot.location.path`.
 * @returns {{ directory: string, directoryName: string, fileName: string }} the validated artifact.
 */
export function classifySessionArtifact(locationPath) {
  if (typeof locationPath !== 'string' || locationPath.length === 0 || locationPath.length > 4096) {
    throw new SessionDeleteFailure('storage-unsupported', 'the session storage location is not a usable path')
  }
  if (locationPath.includes('\0')) {
    throw new SessionDeleteFailure('storage-unsupported', 'the session storage location contains a NUL byte')
  }
  if (!path.isAbsolute(locationPath)) {
    throw new SessionDeleteFailure('storage-unsupported', 'the session storage location is not absolute')
  }
  const fileName = path.basename(locationPath)
  if (!ARTIFACT_FILE_PATTERN.test(fileName)) {
    throw new SessionDeleteFailure(
      'storage-unsupported',
      `the session artifact "${fileName}" is not a recognized session log file`,
    )
  }
  const directory = path.dirname(locationPath)
  const directoryName = path.basename(directory)
  if (directoryName === '' || directoryName === '.' || directoryName === '..' || directoryName === path.parse(directory).root) {
    throw new SessionDeleteFailure('storage-unsupported', 'the session artifact has no session-owned directory')
  }
  if (!ARTIFACT_DIRECTORY_PATTERN.test(directoryName)) {
    throw new SessionDeleteFailure('storage-unsupported', 'the session artifact directory name is not a safe segment')
  }
  if (directory.split(path.sep).filter((segment) => segment !== '').length < 2) {
    throw new SessionDeleteFailure('storage-unsupported', 'the session artifact directory is not nested')
  }
  return { directory, directoryName, fileName }
}

/**
 * Inspect one session-owned directory without modifying it: every entry must be
 * a plain file this plugin recognizes, and the result carries the exact bytes
 * deletion will reclaim.
 * @param {{ directory: string, directoryName: string, fileName: string }} artifact validated artifact.
 * @returns {Promise<{ files: string[], bytes: number }>} the inspect result.
 */
export async function inspectSessionArtifact(artifact) {
  let stats
  try {
    stats = await fs.lstat(artifact.directory)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new SessionDeleteFailure('session-not-found', 'the session artifact directory no longer exists')
    }
    throw new SessionDeleteFailure('delete-failed', `cannot inspect the session artifact directory: ${describeError(error)}`)
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new SessionDeleteFailure('storage-unsupported', 'the session artifact parent is not a plain directory')
  }
  let entries
  try {
    entries = await fs.readdir(artifact.directory, { withFileTypes: true })
  } catch (error) {
    throw new SessionDeleteFailure('delete-failed', `cannot read the session artifact directory: ${describeError(error)}`)
  }
  if (entries.length === 0) {
    // An empty session-owned directory can be left behind by a crash after the
    // backend created it; removing it cannot lose data, so it is still a deletion.
    return { files: [], bytes: 0 }
  }
  const inspected = await Promise.all(
    entries.map(async (entry) => {
      const recognized = ARTIFACT_FILE_PATTERN.test(entry.name) || LOCK_FILE_PATTERN.test(entry.name)
      if (!recognized || !entry.isFile() || entry.isSymbolicLink()) {
        throw new SessionDeleteFailure(
          'storage-unexpected-entry',
          `the session artifact directory contains an entry this plugin does not delete: "${entry.name}"`,
        )
      }
      const filePath = path.join(artifact.directory, entry.name)
      let fileStats
      try {
        fileStats = await fs.lstat(filePath)
      } catch (error) {
        throw new SessionDeleteFailure('delete-failed', `cannot inspect the session artifact: ${describeError(error)}`)
      }
      if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
        throw new SessionDeleteFailure('storage-unexpected-entry', `the session artifact "${entry.name}" is not a plain file`)
      }
      return { name: entry.name, size: fileStats.size }
    }),
  )
  const files = inspected.map((entry) => entry.name)
  const bytes = inspected.reduce((total, entry) => total + entry.size, 0)
  return { files, bytes }
}

/**
 * Remove one validated session-owned artifact directory.
 *
 * The directory is re-validated, atomically renamed out of its canonical path,
 * and only then removed recursively. Renaming first means the Session log
 * disappears from persistence as one atomic step, and the recursive delete can
 * never follow a path that a concurrent writer may have re-created. If the
 * post-rename cleanup fails, the session is already deleted and the returned
 * warning names the hidden staging directory that still needs removal.
 * @param {{ directory: string, directoryName: string }} artifact validated artifact.
 * @returns {Promise<string | undefined>} a cleanup warning, or undefined.
 */
export async function removeSessionArtifact(artifact) {
  await inspectSessionArtifact(artifact)
  const suffix = `.deleting-${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const stagingName = `${artifact.directoryName.slice(0, 255 - suffix.length)}${suffix}`
  const stagingPath = path.join(path.dirname(artifact.directory), stagingName)
  try {
    await fs.rename(artifact.directory, stagingPath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new SessionDeleteFailure('session-not-found', 'the session artifact disappeared before deletion')
    }
    throw new SessionDeleteFailure('delete-failed', `cannot detach the session artifact: ${describeError(error)}`)
  }
  try {
    await fs.rm(stagingPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
    return undefined
  } catch (error) {
    // The canonical artifact is already gone; only the hidden staging copy remains.
    return `staged cleanup incomplete at ${stagingPath}: ${describeError(error)}`
  }
}

/**
 * Resolve the DeepSeek Harness home exactly like `dsh-home-paths`: an explicit
 * non-blank `$DSH_HOME`, else the default under the operating-system home.
 * @param {NodeJS.ProcessEnv} [env] environment to read.
 * @returns {string} the absolute harness home.
 */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * The default on-disk file of one session's projection-cache record.
 * @param {string} sessionId session identity.
 * @param {string} [home] harness home override.
 * @returns {string} the expected cache-record path.
 */
export function projectionCacheFile(sessionId, home = resolveDshHome()) {
  return path.join(home, 'storages', PROJECTION_CACHE_UNIT, 'sessions', `${sessionId}.json`)
}

/**
 * Check the persisted shape of a projection-cache record before touching it.
 * @param {unknown} document parsed JSON document.
 * @returns {boolean} whether the document is one projection-cache record.
 */
export function looksLikeProjectionCacheRecord(document) {
  if (document === null || typeof document !== 'object') return false
  const record = document.record
  if (record === null || typeof record !== 'object') return false
  const identity = record.identity
  return (
    identity !== null
    && typeof identity === 'object'
    && typeof identity.formatVersion === 'number'
    && record.rows !== null
    && typeof record.rows === 'object'
  )
}

/**
 * Best-effort removal of the derived projection cache of one deleted session.
 * The session log stays authoritative, so a failure here is reported as
 * "not removed" and never fails the deletion. The record is removed only when
 * the target resolves to a real file whose parsed content is a projection cache
 * record, so a wrong or reconfigured root can never delete unrelated data.
 * @param {string} sessionId deleted session identity.
 * @param {string} [home] harness home override.
 * @returns {Promise<boolean>} whether a cache record was removed.
 */
export async function removeProjectionCache(sessionId, home = resolveDshHome()) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return false
  const file = projectionCacheFile(sessionId, home)
  try {
    const stats = await fs.lstat(file)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CACHE_RECORD_BYTES) return false
    const raw = await fs.readFile(file, 'utf8')
    if (!looksLikeProjectionCacheRecord(JSON.parse(raw))) return false
    await fs.unlink(file)
    return true
  } catch {
    return false
  }
}

/** @param {unknown} error @returns {string} the error's name when it has one. */
export function errorName(error) {
  return error !== null && typeof error === 'object' && typeof error.name === 'string' ? error.name : ''
}

/** @param {unknown} error @returns {boolean} whether the persistence refused an absent session. */
export function isPersistenceNotFound(error) {
  return errorName(error) === 'SessionPersistenceNotFoundError'
}

/** @param {unknown} error @returns {boolean} whether another writer already owns the session. */
export function isPersistenceOwned(error) {
  return errorName(error) === 'SessionAlreadyOwnedError'
}

/**
 * Map one persistence rejection onto the route's failure vocabulary.
 * @param {unknown} error persistence rejection.
 * @param {string} sessionId session being processed.
 * @returns {SessionDeleteFailure} the mapped failure.
 */
export function persistenceFailure(error, sessionId) {
  const name = errorName(error)
  if (name === 'SessionFormatUnsupportedError' || name === 'SessionPersistenceCorruptionError') {
    return new SessionDeleteFailure('storage-unsupported', `${name}: ${describeError(error)}`, { sessionId })
  }
  return new SessionDeleteFailure('delete-failed', `${describeError(error)}`, { sessionId })
}

/** @param {unknown} error @returns {string} a printable error message. */
function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
