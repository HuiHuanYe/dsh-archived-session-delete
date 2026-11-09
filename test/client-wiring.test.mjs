import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Offline wiring test for the Client half. It evaluates `client.js` exactly like
 * the Web module table does, then drives the registered context-menu
 * contribution and the overlay component with a React stub. Effects are not
 * executed here (no DOM); the live page remains the visual verification.
 */

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  Fragment: 'Fragment',
  useRef(initial) {
    return { current: initial }
  },
  useEffect() {},
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(callback) {
    return callback
  },
}

/** Recursively evaluate function components in a React-stub element tree. */
function expand(node) {
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  const children = Array.isArray(node.children) ? node.children.map(expand) : node.children
  return { ...node, children }
}

function findAll(node, predicate, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) findAll(child, predicate, found)
  return found
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

/** Await the promise queue long enough for the delete flow to settle. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let clientHalfPromise = null

async function loadClientHalf() {
  if (clientHalfPromise !== null) return clientHalfPromise
  clientHalfPromise = (async () => {
    let definition
    globalThis.window = {
      __ModuleLoader__: {
        load(loaded) {
          definition = loaded
        },
      },
    }
    await import('../client.js')
    assert.ok(definition !== undefined, 'client.js must register through window.__ModuleLoader__.load')
    return definition
  })()
  return clientHalfPromise
}

function buildContext() {
  const state = {
    overlay: null,
    menu: null,
    slots: '',
    registrations: [],
    locale: { current: 'zh', dicts: null },
    archived: true,
    allowed: true,
    effects: 0,
  }
  const t = (key, params) => {
    const dictionary = state.locale.dicts?.[state.locale.current] ?? state.locale.dicts?.en ?? {}
    let text = dictionary[key] ?? key
    if (params !== undefined) {
      for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
    }
    return text
  }
  const context = {
    effect: (callback) => {
      state.effects += 1
      callback()
      return () => {}
    },
    locale: {
      register(namespace, dicts) {
        state.locale = { ...state.locale, namespace, dicts }
        return () => {}
      },
      bind() {
        return t
      },
    },
    contextMenus: {
      register(contribution) {
        state.menu = contribution
        return () => {}
      },
    },
    slots: {
      inject(key, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        state.registrations.push({ options, component })
        return () => {}
      },
    },
    workspaces: {
      list: {
        getSnapshot() {
          return {
            items: [],
            archivedSessionIds: state.archived ? ['session-archived'] : [],
            pinnedSessionIds: [],
          }
        },
      },
    },
    remoteAccess: {
      source() {
        return {
          getSnapshot() {
            return state.allowed
          },
        }
      },
    },
  }
  return { context, state, t }
}

test('client half registers locale, icon, overlay and one archived-session context-menu action', async () => {
  const definition = await loadClientHalf()
  assert.equal(definition.id, 'dsh-archived-session-delete')
  const plugin = definition.factory((specifier) => {
    assert.equal(specifier, 'react')
    return reactStub
  })
  assert.deepEqual(plugin.inject, ['contextMenus', 'workspaces', 'remoteAccess', 'locale', 'slots'])
  assert.equal(typeof plugin.apply, 'function')

  const { context, state } = buildContext()
  plugin.apply(context)

  assert.equal(state.effects, 2, 'locale registration and menu registration are effects')
  assert.deepEqual(Object.keys(state.locale.dicts).sort(), ['en', 'zh'])
  assert.deepEqual(Object.keys(state.locale.dicts.zh).sort(), Object.keys(state.locale.dicts.en).sort())
  assert.equal(state.locale.dicts.zh['menu.delete'], '删除归档会话')
  assert.equal(state.locale.dicts.en['menu.delete'], 'Delete archived session')

  const overlay = state.registrations.find((entry) => entry.options.name === 'shell.overlay')
  assert.ok(overlay)
  assert.equal(overlay.options.id, 'archived-session-delete.overlay')
  assert.equal(overlay.options.locale, 'archivedSessionDelete')

  const icon = state.registrations.find((entry) => entry.options.name === 'contextMenu.icon')
  assert.ok(icon)
  assert.equal(icon.options.key, 'archivedSessionDelete.delete')

  assert.ok(state.menu)
  assert.equal(state.menu.id, 'archived-session-delete.deleteArchived')
  assert.equal(state.menu.target, 'session')
  assert.equal(state.menu.order, 700)
  assert.equal(state.menu.observe({ sessionId: 'session-archived' }).length, 3)
})

test('the menu action appears only for an archived, permitted session and opens the confirm dialog', async () => {
  const definition = await loadClientHalf()
  const plugin = definition.factory(() => reactStub)
  const { context, state } = buildContext()
  plugin.apply(context)
  const overlayRegistration = state.registrations.find((entry) => entry.options.name === 'shell.overlay')

  // Unarchived session: no row.
  state.archived = false
  assert.deepEqual(state.menu.resolve({ sessionId: 'session-active', displayTitle: 'Active' }), [])

  // Archived but not permitted: no row.
  state.archived = true
  state.allowed = false
  assert.deepEqual(state.menu.resolve({ sessionId: 'session-archived', displayTitle: 'Archived' }), [])

  // Archived and permitted: one native action row.
  state.allowed = true
  const actions = state.menu.resolve({ sessionId: 'session-archived', displayTitle: '旧的实验' })
  assert.equal(actions.length, 1)
  const action = actions[0]
  assert.equal(action.id, 'delete')
  assert.equal(action.label, '删除归档会话')
  assert.equal(action.danger, true)
  assert.equal(action.separatorBefore, true)
  assert.deepEqual(action.icon, { key: 'archivedSessionDelete.delete' })

  // Initially the overlay renders nothing.
  assert.equal(overlayRegistration.component({ t: () => '' }), null)

  // Selecting the action opens the dialog.
  action.run()
  const dialogTree = expand(overlayRegistration.component({ t: (key, params) => params?.title ? `${key}:${params.title}` : key }))
  const backdrops = findAll(dialogTree, (node) => node.props?.className === 'asd-backdrop')
  assert.equal(backdrops.length, 1)
  const dialog = findAll(dialogTree, (node) => node.props?.role === 'dialog')[0]
  assert.ok(dialog)
  assert.match(textOf(dialog), /dialog\.title/)
  assert.match(textOf(dialog), /旧的实验/)
  const confirm = findAll(dialog, (node) => node.props?.className === 'asd-btn asd-btn-danger')[0]
  assert.ok(confirm)
  assert.equal(confirm.props.disabled, false)
})

test('confirming posts the session id and replaces the dialog with a success toast', async () => {
  const definition = await loadClientHalf()
  const plugin = definition.factory(() => reactStub)
  const { context, state } = buildContext()
  plugin.apply(context)
  const overlayRegistration = state.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const actions = state.menu.resolve({ sessionId: 'session-archived', displayTitle: '旧的实验' })
  actions[0].run()

  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, bytes: 2 * 1024 * 1024 }) }
  }
  try {
    const t = (key, params) => {
      let text = state.locale.dicts.zh[key] ?? key
      if (params !== undefined) {
        for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
      }
      return text
    }
    let tree = expand(overlayRegistration.component({ t }))
    let confirm = findAll(tree, (node) => node.props?.className === 'asd-btn asd-btn-danger')[0]
    confirm.props.onClick()
    await flush()
    tree = expand(overlayRegistration.component({ t }))
    assert.equal(findAll(tree, (node) => node.props?.role === 'dialog').length, 0)
    const toast = findAll(tree, (node) => node.props?.className === 'asd-toast')[0]
    assert.ok(toast)
    assert.match(textOf(toast), /已删除归档会话「旧的实验」/)
    assert.match(textOf(toast), /2\.00 MB/)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'api/archived-sessions.delete')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 'session-archived' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a structured Host refusal keeps the dialog open with a localized reason', async () => {
  const definition = await loadClientHalf()
  const plugin = definition.factory(() => reactStub)
  const { context, state } = buildContext()
  plugin.apply(context)
  const overlayRegistration = state.registrations.find((entry) => entry.options.name === 'shell.overlay')
  state.menu.resolve({ sessionId: 'session-archived', displayTitle: '旧的实验' })[0].run()

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ ok: false, code: 'session-scheduled', message: 'scheduled' }),
  })
  try {
    const t = (key) => state.locale.dicts.zh[key] ?? key
    let tree = expand(overlayRegistration.component({ t }))
    findAll(tree, (node) => node.props?.className === 'asd-btn asd-btn-danger')[0].props.onClick()
    await flush()
    tree = expand(overlayRegistration.component({ t }))
    assert.equal(findAll(tree, (node) => node.props?.role === 'dialog').length, 1)
    const alert = findAll(tree, (node) => node.props?.role === 'alert')[0]
    assert.ok(alert)
    assert.match(textOf(alert), /定时任务/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a session that disappeared is reported as already gone instead of an error', async () => {
  const definition = await loadClientHalf()
  const plugin = definition.factory(() => reactStub)
  const { context, state } = buildContext()
  plugin.apply(context)
  const overlayRegistration = state.registrations.find((entry) => entry.options.name === 'shell.overlay')
  state.menu.resolve({ sessionId: 'session-archived', displayTitle: '旧的实验' })[0].run()

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ ok: false, code: 'session-not-found', message: 'gone' }),
  })
  try {
    const t = (key) => state.locale.dicts.zh[key] ?? key
    let tree = expand(overlayRegistration.component({ t }))
    findAll(tree, (node) => node.props?.className === 'asd-btn asd-btn-danger')[0].props.onClick()
    await flush()
    tree = expand(overlayRegistration.component({ t }))
    assert.equal(findAll(tree, (node) => node.props?.role === 'dialog').length, 0)
    assert.match(textOf(findAll(tree, (node) => node.props?.className === 'asd-toast')[0]), /已不存在/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an unsupported storage backend keeps its dedicated explanation', async () => {
  const definition = await loadClientHalf()
  const plugin = definition.factory(() => reactStub)
  const { context, state } = buildContext()
  plugin.apply(context)
  const overlayRegistration = state.registrations.find((entry) => entry.options.name === 'shell.overlay')
  state.menu.resolve({ sessionId: 'session-archived', displayTitle: '旧的实验' })[0].run()

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ ok: false, code: 'storage-unsupported', message: 'unsupported' }),
  })
  try {
    const t = (key) => state.locale.dicts.zh[key] ?? key
    let tree = expand(overlayRegistration.component({ t }))
    findAll(tree, (node) => node.props?.className === 'asd-btn asd-btn-danger')[0].props.onClick()
    await flush()
    tree = expand(overlayRegistration.component({ t }))
    const alert = findAll(tree, (node) => node.props?.role === 'alert')[0]
    assert.ok(alert)
    assert.match(textOf(alert), /不支持安全删除/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a request timeout is reported instead of leaving the dialog busy forever', async () => {
  const definition = await loadClientHalf()
  const plugin = definition.factory(() => reactStub)
  const { context, state } = buildContext()
  plugin.apply(context)
  const overlayRegistration = state.registrations.find((entry) => entry.options.name === 'shell.overlay')
  state.menu.resolve({ sessionId: 'session-archived', displayTitle: '旧的实验' })[0].run()

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
  try {
    const t = (key) => state.locale.dicts.zh[key] ?? key
    let tree = expand(overlayRegistration.component({ t }))
    findAll(tree, (node) => node.props?.className === 'asd-btn asd-btn-danger')[0].props.onClick()
    await flush()
    tree = expand(overlayRegistration.component({ t }))
    assert.equal(findAll(tree, (node) => node.props?.role === 'dialog').length, 1)
    const dialog = findAll(tree, (node) => node.props?.role === 'dialog')[0]
    assert.equal(dialog.props['aria-busy'], undefined)
    const alert = findAll(tree, (node) => node.props?.role === 'alert')[0]
    assert.ok(alert)
    assert.match(textOf(alert), /超时/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
