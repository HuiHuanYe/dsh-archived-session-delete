import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SessionDeleteFailure,
  classifySessionArtifact,
  inspectSessionArtifact,
  looksLikeProjectionCacheRecord,
  parseDeleteRequest,
  projectionCacheFile,
  removeProjectionCache,
  removeSessionArtifact,
} from '../lib/session-delete.js'

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dsh-archived-session-delete-'))
}

function sessionArtifactPath(root, sessionId = 'session-11111111-2222-3333-4444-555555555555') {
  return path.join(root, '--project--', sessionId, 'session.v4.jsonl.zstd')
}

test('parseDeleteRequest accepts one plain session id', () => {
  assert.equal(parseDeleteRequest({ sessionId: 'session-abc' }), 'session-abc')
  assert.equal(parseDeleteRequest({ sessionId: 'a.b_c-9' }), 'a.b_c-9')
})

test('parseDeleteRequest rejects malformed payloads', () => {
  for (const payload of [null, undefined, [], 'x', { sessionId: 'a/b' }, { sessionId: '../x' }, { sessionId: '' }, { sessionId: 7 }]) {
    assert.throws(() => parseDeleteRequest(payload), (error) => {
      assert.ok(error instanceof SessionDeleteFailure)
      assert.equal(error.code, 'invalid-request')
      return true
    })
  }
})

test('classifySessionArtifact validates the reported artifact', async () => {
  const root = await makeTempRoot()
  try {
    const location = sessionArtifactPath(root)
    const artifact = classifySessionArtifact(location)
    assert.equal(artifact.directory, path.dirname(location))
    assert.equal(artifact.fileName, 'session.v4.jsonl.zstd')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('classifySessionArtifact rejects relative, unknown, and root locations', () => {
  for (const location of [
    'session.v4.jsonl.zstd',
    path.join(os.tmpdir(), 'session-uuid', 'notes.txt'),
    path.join(os.tmpdir(), 'session-uuid', 'session.lock'),
    path.join(os.tmpdir(), 'session-uuid', 'session.notes.jsonl'),
    path.sep + 'session.v4.jsonl.zstd',
    '',
    42,
  ]) {
    assert.throws(() => classifySessionArtifact(location), (error) => {
      assert.ok(error instanceof SessionDeleteFailure)
      assert.equal(error.code, 'storage-unsupported')
      return true
    })
  }
})

test('inspectSessionArtifact measures only session-owned files and removeSessionArtifact deletes the directory', async () => {
  const root = await makeTempRoot()
  try {
    const location = sessionArtifactPath(root)
    await fs.mkdir(path.dirname(location), { recursive: true })
    await fs.writeFile(location, 'compressed-log')
    const inspected = await inspectSessionArtifact(classifySessionArtifact(location))
    assert.deepEqual(inspected.files, ['session.v4.jsonl.zstd'])
    assert.equal(inspected.bytes, 14)
    await removeSessionArtifact(classifySessionArtifact(location))
    await assert.rejects(fs.lstat(path.dirname(location)), { code: 'ENOENT' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('inspectSessionArtifact tolerates a writer lock but refuses unknown entries', async () => {
  const root = await makeTempRoot()
  try {
    const location = sessionArtifactPath(root)
    await fs.mkdir(path.dirname(location), { recursive: true })
    await fs.writeFile(location, 'log')
    await fs.writeFile(path.join(path.dirname(location), 'session.lock'), '')
    const inspected = await inspectSessionArtifact(classifySessionArtifact(location))
    assert.deepEqual(inspected.files.sort(), ['session.lock', 'session.v4.jsonl.zstd'])

    await fs.writeFile(path.join(path.dirname(location), 'notes.txt'), 'leave me')
    await assert.rejects(inspectSessionArtifact(classifySessionArtifact(location)), (error) => {
      assert.ok(error instanceof SessionDeleteFailure)
      assert.equal(error.code, 'storage-unexpected-entry')
      return true
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('removeSessionArtifact re-validates immediately before removing', async () => {
  const root = await makeTempRoot()
  try {
    const location = sessionArtifactPath(root)
    await fs.mkdir(path.dirname(location), { recursive: true })
    await fs.writeFile(location, 'log')
    const artifact = classifySessionArtifact(location)
    await inspectSessionArtifact(artifact)
    await fs.writeFile(path.join(path.dirname(location), 'notes.txt'), 'appeared later')
    await assert.rejects(removeSessionArtifact(artifact), (error) => {
      assert.ok(error instanceof SessionDeleteFailure)
      assert.equal(error.code, 'storage-unexpected-entry')
      return true
    })
    assert.equal((await fs.lstat(location)).isFile(), true, 'nothing is removed on a failed re-validation')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('an empty session-owned directory is inspectable and removable', async () => {
  const root = await makeTempRoot()
  try {
    const location = sessionArtifactPath(root)
    await fs.mkdir(path.dirname(location), { recursive: true })
    const artifact = classifySessionArtifact(location)
    const inspected = await inspectSessionArtifact(artifact)
    assert.deepEqual(inspected.files, [])
    assert.equal(inspected.bytes, 0)
    await removeSessionArtifact(artifact)
    await assert.rejects(fs.lstat(path.dirname(location)), { code: 'ENOENT' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('looksLikeProjectionCacheRecord recognizes the persisted record shape', () => {
  assert.equal(looksLikeProjectionCacheRecord({ version: 7, record: { identity: { formatVersion: 4 }, rows: {} } }), true)
  assert.equal(looksLikeProjectionCacheRecord({ version: 7, record: {} }), false)
  assert.equal(looksLikeProjectionCacheRecord({ record: { identity: { formatVersion: 4 }, rows: [] } }), true)
  assert.equal(looksLikeProjectionCacheRecord(null), false)
  assert.equal(looksLikeProjectionCacheRecord('text'), false)
})

test('removeProjectionCache removes only a verified cache record', async () => {
  const root = await makeTempRoot()
  try {
    const sessionId = 'session-cache'
    const file = projectionCacheFile(sessionId, root)
    await fs.mkdir(path.dirname(file), { recursive: true })

    await fs.writeFile(file, JSON.stringify({ version: 7, record: { identity: { formatVersion: 4 }, rows: {} } }))
    assert.equal(await removeProjectionCache(sessionId, root), true)
    await assert.rejects(fs.lstat(file), { code: 'ENOENT' })

    await fs.writeFile(file, JSON.stringify({ hello: 'world' }))
    assert.equal(await removeProjectionCache(sessionId, root), false)
    assert.equal((await fs.lstat(file)).isFile(), true)

    await fs.writeFile(file, 'not json')
    assert.equal(await removeProjectionCache(sessionId, root), false)
    assert.equal((await fs.lstat(file)).isFile(), true)

    // Unsafe ids never reach a computed path, even if a caller bypassed validation.
    assert.equal(await removeProjectionCache('../../escape', root), false)
    assert.equal(await removeProjectionCache('', root), false)
    assert.equal(await removeProjectionCache(null, root), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
