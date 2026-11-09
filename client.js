/**
 * Client half of dsh-archived-session-delete.
 *
 * Registers one structured Session context-menu action (native menu rendering,
 * keyboard navigation, danger styling and icon seat) that appears only for
 * archived Sessions, plus a small self-contained confirmation dialog and toast
 * rendered into the frame-wide `shell.overlay` seat.
 *
 * The half is plain JavaScript loaded through the Web module table; it requires
 * only React and deliberately styles itself with `--dsw-alias-*` theme tokens so
 * it follows light/dark switching without importing Harness client packages.
 */
window.__ModuleLoader__.load({
  id: 'dsh-archived-session-delete',
  factory(require) {
    'use strict'

    const React = require('react')

    /** Locale namespace owned by this plugin. */
    const NS = 'archivedSessionDelete'
    /** Icon key registered in the context menu's icon seat. */
    const ICON_KEY = 'archivedSessionDelete.delete'
    /**
     * Document-relative form of the Host route, resolved against the page base.
     * Keep in sync with DELETE_ROUTE_PATH in lib/session-delete.js.
     */
    const ROUTE = '/api/archived-sessions.delete'.slice(1)
    /** Abort the Host request when it stops answering, so the dialog cannot hang. */
    const REQUEST_TIMEOUT_MS = 30000

    const CSS = `
.asd-backdrop{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42);animation:asd-fade .12s ease-out}
.asd-dialog{width:min(420px,100%);box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:12px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,inherit);box-shadow:0 16px 48px rgba(0,0,0,.24);padding:20px 20px 16px;font-size:13px;line-height:1.55;outline:none}
.asd-title{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,inherit)}
.asd-desc{margin-top:10px;color:var(--dsw-alias-label-secondary,inherit);word-break:break-word}
.asd-detail{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit);opacity:.85}
.asd-status{margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
.asd-error{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:12px;color:var(--dsw-alias-state-error-primary,#d54941);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d54941) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#d54941) 32%,transparent)}
.asd-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.asd-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}
.asd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.asd-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}
.asd-btn:disabled{opacity:.55;cursor:default}
.asd-btn-danger{color:var(--dsw-alias-state-error-primary,#d54941);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d54941) 45%,transparent)}
.asd-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d54941) 10%,transparent);border-color:var(--dsw-alias-state-error-primary,#d54941)}
.asd-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2001;max-width:min(560px,calc(100vw - 32px));padding:10px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,inherit);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:13px;line-height:1.5;cursor:default;animation:asd-rise .16s ease-out}
@keyframes asd-fade{from{opacity:0}to{opacity:1}}
@keyframes asd-rise{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}
@media (prefers-reduced-motion:reduce){.asd-backdrop{animation:none}.asd-toast{animation:none}}
`

    /** English dictionary (fallback for every unregistered locale). */
    const en = {
      'menu.delete': 'Delete archived session',
      'dialog.title': 'Permanently delete this archived session?',
      'dialog.desc': 'The complete conversation history of “{title}” will be permanently deleted from this device. This cannot be undone.',
      'dialog.detail': 'The session log, its sub-session logs and the local projection cache are removed.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete permanently',
      'dialog.busy': 'Deleting…',
      'error.inUse': 'This session is still in use (running or opened elsewhere). Try again later.',
      'error.scheduled': 'This session still has active scheduled tasks. Pause or delete them first.',
      'error.jobs': 'This session still has running background jobs. Wait for or stop them first.',
      'error.notArchived': 'Only archived sessions can be deleted. Restore the archived filter and retry.',
      'error.pending': 'This session has not been written to disk yet (send one message first), so it cannot be deleted.',
      'error.workCheck': 'Could not verify whether this session still runs work; the delete was cancelled.',
      'error.lineage': 'Could not verify the sub-session scope of this session; the delete was cancelled.',
      'error.migration': 'This session still uses an older storage format and cannot be deleted yet.',
      'error.unsupported': 'The current storage backend does not allow deleting this session safely.',
      'error.unexpected': 'The session directory contains files this plugin does not delete. Nothing was removed.',
      'error.busy': 'Another delete request for this session is already running.',
      'error.invalid': 'The delete request was rejected as invalid.',
      'error.partial': 'Some session files could not be deleted. Try again in a moment.',
      'error.timeout': 'The delete request timed out; it may still be running. Refresh in a moment to check.',
      'error.failed': 'Delete failed: {message}',
      'toast.deleted': 'Deleted archived session “{title}”.',
      'toast.deletedSize': 'Deleted archived session “{title}” and freed {size}.',
      'toast.gone': 'That session no longer exists.',
    }

    /** Simplified Chinese dictionary. */
    const zh = {
      'menu.delete': '删除归档会话',
      'dialog.title': '永久删除该归档会话？',
      'dialog.desc': '将把「{title}」的完整对话记录从本机永久删除，且无法恢复。',
      'dialog.detail': '会话日志、其子会话日志与本地投影缓存将一并清除。',
      'dialog.cancel': '取消',
      'dialog.confirm': '永久删除',
      'dialog.busy': '正在删除…',
      'error.inUse': '该会话仍在使用中（正在运行或已在别处打开），请稍后再试。',
      'error.scheduled': '该会话还有活动中的定时任务，请先暂停或删除这些任务。',
      'error.jobs': '该会话还有运行中的后台任务，请先等待其结束或停止它们。',
      'error.notArchived': '只能删除已归档的会话。请切换到归档视图后重试。',
      'error.pending': '该会话还没有落盘（先发送一条消息即可），暂不能删除。',
      'error.workCheck': '无法确认该会话是否仍有运行中的任务，已中止删除。',
      'error.lineage': '无法确认该会话的子会话范围，已中止删除。',
      'error.migration': '该会话仍使用旧版存储格式，暂不能直接删除。',
      'error.unsupported': '当前存储后端不支持安全删除该会话。',
      'error.unexpected': '会话目录中存在本插件不会删除的文件，已放弃删除。',
      'error.busy': '该会话已有一个删除操作在进行中。',
      'error.invalid': '删除请求不合法，已被拒绝。',
      'error.partial': '部分会话文件删除失败，请稍后重试。',
      'error.timeout': '请求超时：删除可能仍在后台进行，请稍后刷新确认结果。',
      'error.failed': '删除失败：{message}',
      'toast.deleted': '已删除归档会话「{title}」。',
      'toast.deletedSize': '已删除归档会话「{title}」，释放 {size}。',
      'toast.gone': '该会话已不存在。',
    }

    /**
     * Minimal observable value shared by the menu callback, the dialog, and the
     * toast. React reads it through useSyncExternalStore.
     * @param {{ dialog: object | null, busy: boolean, error: string | null, toast: object | null }} initial state.
     * @returns {{ get: Function, set: Function, subscribe: Function }} the store.
     */
    function createStore(initial) {
      let value = initial
      /** @type {Set<Function>} */
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {
              console.error('[archived-session-delete] store listener failed:', error)
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    const ui = createStore({ dialog: null, busy: false, error: null, toast: null })

    /** @param {unknown} error @returns {string} a printable message. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** @param {number} bytes @returns {string} a compact binary size. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
      return `${value.toFixed(digits)} ${units[unit]}`
    }

    /** @param {{ dialog: object | null, busy: boolean, error: string | null, toast: object | null }} state @param {object | null} toast @returns {object} next state */
    function withToast(state, toast) {
      return { ...state, toast }
    }

    /**
     * Open the confirmation dialog for one archived Session.
     * @param {string} sessionId session identity.
     * @param {string} displayTitle row title the request captured.
     * @returns {void}
     */
    function openDialog(sessionId, displayTitle) {
      const title = typeof displayTitle === 'string' && displayTitle.trim() !== '' ? displayTitle : sessionId
      const returnFocus = typeof document === 'undefined' ? null : document.activeElement
      ui.set({ dialog: { sessionId, displayTitle: title, returnFocus }, busy: false, error: null, toast: null })
    }

    /** Close the open dialog unless a delete is in flight. @returns {void} */
    function closeDialog() {
      const state = ui.get()
      if (state.dialog === null || state.busy) return
      const returnFocus = state.dialog.returnFocus
      ui.set({ dialog: null, busy: false, error: null, toast: state.toast })
      restoreFocus(returnFocus)
    }

    /**
     * Restore focus to the control that opened the dialog.
     * @param {Element | null} element previously focused element.
     * @returns {void}
     */
    function restoreFocus(element) {
      if (element === null || element === undefined) return
      if (typeof element.focus !== 'function') return
      try {
        if (element.isConnected === false) return
        element.focus()
      } catch {
        /* focus target disappeared */
      }
    }

    /** Dismiss the current toast. @returns {void} */
    function dismissToast() {
      const state = ui.get()
      if (state.toast !== null) ui.set(withToast(state, null))
    }

    /**
     * Call the Host route.
     * @param {string} sessionId session identity.
     * @returns {Promise<{ ok: boolean, status: number, payload: any }>} normalized result.
     */
    async function postDelete(sessionId) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
          signal: controller.signal,
        })
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        return { ok: response.ok && payload !== null && payload.ok === true, status: response.status, payload }
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * Localize the structured failure the Host returned.
     * @param {{ payload: any }} result request result.
     * @param {Function} t locale translate.
     * @returns {string} display text.
     */
    function errorText(result, t) {
      const code = result.payload !== null && typeof result.payload === 'object' ? result.payload.code : undefined
      switch (code) {
        case 'session-in-use':
          return t('error.inUse')
        case 'session-scheduled':
          return t('error.scheduled')
        case 'session-jobs-running':
          return t('error.jobs')
        case 'session-not-archived':
          return t('error.notArchived')
        case 'session-pending':
          return t('error.pending')
        case 'work-check-unavailable':
          return t('error.workCheck')
        case 'lineage-unavailable':
          return t('error.lineage')
        case 'storage-migration-required':
          return t('error.migration')
        case 'storage-unsupported':
          return t('error.unsupported')
        case 'storage-unexpected-entry':
          return t('error.unexpected')
        case 'delete-busy':
          return t('error.busy')
        case 'invalid-request':
          return t('error.invalid')
        case 'delete-partial':
          return t('error.partial')
        default:
          return t('error.failed', { message: messageOf(result.payload?.message ?? `HTTP ${result.status}`) })
      }
    }

    /**
     * Confirm and execute one deletion, updating dialog and toast state.
     * @param {Function} t locale translate.
     * @returns {Promise<void>} resolution when the request settled.
     */
    async function confirmDelete(t) {
      const state = ui.get()
      const dialog = state.dialog
      if (dialog === null || state.busy) return
      ui.set({ ...state, busy: true, error: null })
      let result
      try {
        result = await postDelete(dialog.sessionId)
      } catch (error) {
        const timedOut = error !== null && typeof error === 'object' && error.name === 'AbortError'
        ui.set({
          ...ui.get(),
          busy: false,
          error: timedOut ? t('error.timeout') : t('error.failed', { message: messageOf(error) }),
        })
        return
      }
      const current = ui.get()
      if (current.dialog === null || current.dialog.sessionId !== dialog.sessionId) return
      const payloadCode = result.payload !== null && typeof result.payload === 'object' ? result.payload.code : undefined
      if (result.ok || payloadCode === 'session-not-found') {
        const bytes = result.payload !== null && typeof result.payload === 'object' ? result.payload.bytes : undefined
        const text =
          typeof bytes === 'number' && bytes > 0
            ? t('toast.deletedSize', { title: dialog.displayTitle, size: formatBytes(bytes) })
            : result.ok
              ? t('toast.deleted', { title: dialog.displayTitle })
              : t('toast.gone')
        const returnFocus = dialog.returnFocus
        ui.set({ dialog: null, busy: false, error: null, toast: { id: Date.now() + Math.random(), text } })
        restoreFocus(returnFocus)
        return
      }
      ui.set({ ...ui.get(), busy: false, error: errorText(result, t) })
    }

    /** The trash glyph registered into the native context-menu icon seat. @returns {object} SVG element. */
    function TrashIcon() {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block', pointerEvents: 'none' },
        },
        React.createElement('path', {
          d: 'M2.5 4.5h11M6 4.5V3.4c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.1M3.8 4.5l.6 8.4c.05.5.5.9 1 .9h5.2c.5 0 .95-.4 1-.9l.6-8.4M6.6 7.1v4.4M9.4 7.1v4.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * Confirmation dialog with focus handling and a destructive confirm button.
     * @param {{ dialog: object, busy: boolean, error: string | null, onCancel: Function, onConfirm: Function, t: Function }} props component props.
     * @returns {object} the dialog element.
     */
    function ConfirmDialog({ dialog, busy, error, onCancel, onConfirm, t }) {
      const dialogRef = React.useRef(null)
      const cancelRef = React.useRef(null)
      const busyRef = React.useRef(busy)
      busyRef.current = busy

      React.useEffect(() => {
        const previous = document.activeElement
        const focusCancel = () => {
          if (cancelRef.current !== null && typeof cancelRef.current.focus === 'function') cancelRef.current.focus()
        }
        focusCancel()
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(focusCancel) : 0
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (!busyRef.current) onCancel()
            return
          }
          if (event.key !== 'Tab') return
          const root = dialogRef.current
          if (root === null) return
          const focusable = [...root.querySelectorAll('button:not([disabled])')]
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          if (raf !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous !== null && previous !== document.body) restoreFocus(previous)
        }
        // The dialog instance identity is the request; busy/error changes must not
        // re-run focus restoration.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [dialog.sessionId])

      return React.createElement(
        'div',
        {
          className: 'asd-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel()
          },
        },
        React.createElement(
          'div',
          {
            ref: dialogRef,
            className: 'asd-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-busy': busy ? 'true' : undefined,
            'aria-labelledby': 'asd-title',
            'aria-describedby': 'asd-desc',
            onMouseDown: (event) => event.stopPropagation(),
          },
          React.createElement('div', { className: 'asd-title', id: 'asd-title' }, t('dialog.title')),
          React.createElement('div', { className: 'asd-desc', id: 'asd-desc' }, t('dialog.desc', { title: dialog.displayTitle })),
          React.createElement('div', { className: 'asd-detail' }, t('dialog.detail')),
          busy ? React.createElement('div', { className: 'asd-status', role: 'status' }, t('dialog.busy')) : null,
          error !== null ? React.createElement('div', { className: 'asd-error', role: 'alert' }, error) : null,
          React.createElement(
            'div',
            { className: 'asd-actions' },
            React.createElement(
              'button',
              { ref: cancelRef, type: 'button', className: 'asd-btn', disabled: busy, onClick: onCancel },
              t('dialog.cancel'),
            ),
            React.createElement(
              'button',
              { type: 'button', className: 'asd-btn asd-btn-danger', disabled: busy, onClick: onConfirm },
              t('dialog.confirm'),
            ),
          ),
        ),
      )
    }

    /**
     * Self-dismissing success notice.
     * @param {{ toast: object, t: Function, onDismiss: Function }} props component props.
     * @returns {object} the toast element.
     */
    function Toast({ toast, t, onDismiss }) {
      React.useEffect(() => {
        const timer = setTimeout(onDismiss, 4200)
        return () => clearTimeout(timer)
      }, [toast.id, onDismiss])
      return React.createElement(
        'div',
        {
          className: 'asd-toast',
          role: 'status',
          'aria-live': 'polite',
          onClick: onDismiss,
        },
        toast.text,
      )
    }

    /**
     * Frame-wide overlay: the confirmation dialog and the success toast.
     * @param {{ t: Function }} props component props (from the locale seat).
     * @returns {object | null} overlay elements or null.
     */
    function Overlay({ t }) {
      const state = React.useSyncExternalStore(ui.subscribe, ui.get, ui.get)
      if (state.dialog === null && state.toast === null) return null
      const children = [React.createElement('style', { key: 'css' }, CSS)]
      if (state.dialog !== null) {
        children.push(
          React.createElement(ConfirmDialog, {
            key: 'dialog',
            dialog: state.dialog,
            busy: state.busy,
            error: state.error,
            t,
            onCancel: () => closeDialog(),
            onConfirm: () => {
              void confirmDelete(t)
            },
          }),
        )
      }
      if (state.toast !== null) {
        children.push(React.createElement(Toast, { key: 'toast', toast: state.toast, t, onDismiss: () => dismissToast() }))
      }
      return React.createElement(React.Fragment, null, children)
    }

    /**
     * Observables that re-resolve the contribution: archive membership, locale,
     * and the Session resource permission the row requires.
     * @param {any} ctx client plugin context.
     * @param {string} sessionId captured session identity.
     * @returns {Array<object>} observable sources.
     */
    function menuSources(ctx, sessionId) {
      const sources = []
      try {
        if (ctx.workspaces !== undefined && ctx.workspaces.list !== undefined) sources.push(ctx.workspaces.list)
      } catch {
        /* membership is unavailable; the row stays hidden */
      }
      try {
        sources.push(ctx.locale)
      } catch {
        /* locale is required by the plugin inject */
      }
      try {
        sources.push(ctx.remoteAccess.source('session', sessionId, 'workspace/unarchiveSession'))
      } catch {
        /* permission source unavailable */
      }
      return sources
    }

    /** @param {any} ctx client plugin context @param {string} sessionId session identity @returns {boolean} whether the row targets an archived Session. */
    function isArchived(ctx, sessionId) {
      try {
        const snapshot = ctx.workspaces.list.getSnapshot()
        return Array.isArray(snapshot.archivedSessionIds) && snapshot.archivedSessionIds.includes(sessionId)
      } catch {
        return false
      }
    }

    /** @param {any} ctx client plugin context @param {string} sessionId session identity @returns {boolean} whether this peer may act on the Session. */
    function mayDelete(ctx, sessionId) {
      try {
        return ctx.remoteAccess.source('session', sessionId, 'workspace/unarchiveSession').getSnapshot() === true
      } catch {
        return false
      }
    }

    /**
     * Resolve the native menu row for one Session target.
     * @param {any} ctx client plugin context.
     * @param {{ sessionId: string, displayTitle?: string }} target captured session target.
     * @returns {Array<object>} zero or one menu action.
     */
    function resolveSessionActions(ctx, target) {
      if (target === null || typeof target !== 'object' || typeof target.sessionId !== 'string') return []
      const sessionId = target.sessionId
      if (!isArchived(ctx, sessionId)) return []
      if (!mayDelete(ctx, sessionId)) return []
      const t = ctx.locale.bind(NS)
      return [
        {
          id: 'delete',
          label: t('menu.delete'),
          icon: { key: ICON_KEY },
          danger: true,
          separatorBefore: true,
          run: () => openDialog(sessionId, target.displayTitle),
        },
      ]
    }

    /**
     * Client plugin entry.
     * @param {any} ctx client plugin context.
     * @returns {void}
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'archived-session-delete: dictionaries')
      ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name: 'contextMenu.icon', key: ICON_KEY }, TrashIcon))
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'archived-session-delete.overlay', locale: NS }, Overlay),
      )
      ctx.effect(
        () =>
          ctx.contextMenus.register({
            id: 'archived-session-delete.deleteArchived',
            target: 'session',
            order: 700,
            observe: ({ sessionId }) => menuSources(ctx, sessionId),
            resolve: (target) => resolveSessionActions(ctx, target),
          }),
        'archived-session-delete: session menu',
      )
    }

    return {
      name: 'dsh-archived-session-delete',
      inject: ['contextMenus', 'workspaces', 'remoteAccess', 'locale', 'slots'],
      apply,
    }
  },
})
