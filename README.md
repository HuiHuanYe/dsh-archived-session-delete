# dsh-archived-session-delete

为 DSH Web 侧边栏的**归档会话**增加「删除归档会话」：二次确认后永久删除该会话在本机的日志，
并清理子会话日志、归档登记与派生的投影缓存。

> English: Adds a permanent *Delete archived session* action to the DSH Web sidebar. Deletion is
> fail-closed, refuses sessions that are still in use, and cleans up subagent logs, the archive
> entry and derived caches.

`MIT` · `DSH 0.2.2-rc.1` · `Node ≥ 24` · `35 tests passing`
仓库：<https://github.com/HuiHuanYe/dsh-archived-session-delete>

## 功能

- 只在归档会话的右键菜单 / `⋯` 菜单中显示，使用 DSH 原生菜单服务（键盘导航、焦点、危险色由宿主处理）。
- 确认框说明「永久删除、无法撤销」，支持 Esc / 遮罩关闭 / 焦点循环。
- 删除权威会话日志目录（含历史代际）、子会话日志、`workspace` 归档登记、`session_projcache` 缓存，
  并广播 `api-session/removed` 让所有已连接页面即时移除该行。
- 删除前完整预检：Host 校验归档状态、全程持有写声明、检查后台任务与定时任务；目录内有未知文件即放弃。
- 中英双语；不提供 agent 工具（不可撤销操作只保留用户手势入口）。

## 安装

```powershell
git clone https://github.com/HuiHuanYe/dsh-archived-session-delete.git
```

- 在 **DSH → 设置 → 插件 → 从目录安装** 中选择该目录；CLI profile 也可
  `dsh plugin --profile <name> add 'link:<绝对路径>'`（桌面 profile 由 Electron 独占管理，请用插件页）。
- 或直接安装仓库：`dsh plugin --profile <name> add github:HuiHuanYe/dsh-archived-session-delete`。
- 安装后若未热加载，**重启一次 DSH** 即可；卸载在插件页移除 Bundle，已删除的会话不会恢复。

## 使用

1. 侧边栏 **视图选项 → 会话筛选** 选「全部对话（显示已归档）」或「仅显示已归档」。
2. 右键灰色归档会话（或行尾 `⋯`）→ **删除归档会话**。
3. 确认框点 **永久删除**；成功后提示释放空间，行从列表消失。

## 实现要点

Host 端（`index.js` + `lib/session-delete.js`）在 `/api` 认证通道注册
`POST /api/archived-sessions.delete`，只接受已认证 owner Peer：

1. **规划**：校验归档集合 → 收集 `origin: 'subagent'` 子会话（fork 不跟随）→
   `sessionPersistence.stat()` 定位并结构校验日志 → `open(id, 'write')` 并全程持有写声明 →
   检查 `jobs` / `schedule`。
2. **执行**：子会话先删、祖先最后；子失败则阻塞祖先以便重试；删除前再次校验目录，
   然后删除权威目录、清归档登记与投影缓存、广播 `api-session/removed`。
3. **失败关闭**：路径不合法、目录有未知文件、stat 不可解析、未落盘、任务目录读不到、lineage 失败
   等情况一律拒绝并返回结构化错误码（如 `session-not-archived`、`session-pending`、`session-in-use`、
   `session-scheduled`、`work-check-unavailable`、`storage-unsupported`），客户端按码本地化提示。

客户端（`client.js`）通过 `ctx.contextMenus` 贡献菜单项，用 `shell.overlay` 渲染确认框与 Toast。

## 删除与保留

| 删除 | 保留 |
|---|---|
| 会话日志目录（含历史代际） | 附件（内容寻址，可能跨会话共享，无删除 API） |
| 子会话日志、归档登记、投影缓存 | SQLite 搜索索引（派生库，下次搜索时自动对账） |

## 限制

- 未落盘会话（新建后未发消息）拒绝删除：`session-pending`。
- 旧格式（`migration-required`）会话拒绝删除。
- 超时只中止浏览器请求，Host 可能仍会完成删除；稍后刷新确认。
- 请求体按 64 KiB 上限处理（仅防处理侧解析开销；`/api` 桥接层另有总量限制，且仅 owner 可访问）。

## 开发与测试

```powershell
npm run check   # node --check index.js client.js lib/session-delete.js
npm test        # 35 个 node:test 用例
```

测试覆盖请求校验、路径安全、目录清点/删除、Host 路由（假 Cordis ctx + 真实临时文件系统）、
归档校验、pending/损坏 artifact、fork 过滤、并发与失败关闭、客户端菜单/弹窗/Toast。

隔离 profile 已用真实 DSH 服务端到端验证：未归档删除返回 409；真实 RPC 归档后删除 200 并移除
677,485 B 目录；归档但日志已缺失时返回 200 `alreadyGone`；无 staging 残留、写声明正常释放。

## 兼容性

DSH 0.2.2-rc.1（已验证）· Node ≥ 24 · Windows 已实测。需要 `connection`、`sessionPersistence`、
`workspaceRegistry`，可选 `sessionQuery`、`jobs`、`schedule`；无构建步骤。

## 许可证

[MIT](LICENSE) © 2026 dsh-archived-session-delete contributors
