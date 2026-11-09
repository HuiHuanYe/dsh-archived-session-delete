# dsh-archived-session-delete

**为 DSH Web 侧边栏的「归档会话」增加一个真正可用的永久删除入口。**

DSH 的归档只能把会话「藏起来」：界面明确不提供删除，日志会一直留在本机磁盘上。本插件在归档会话的
右键菜单（以及行尾 `⋯` 菜单）中增加 **删除归档会话**，二次确认后删除会话在本机的全部对话日志，
并同步清理其子会话日志、归档登记与派生缓存。

> English: A DeepSeek Harness Web plugin that adds a permanent **Delete archived session** action
> to the sidebar session context menu. It validates every storage path fail-closed, refuses sessions
> that are still in use or targeted by running work, and cleans up subagent logs, the archive entry
> and derived caches.

`License: MIT` · `DSH: 0.2.2-rc.1` · `Node: ≥ 24` · `Tests: 35 passing`

- 仓库：<https://github.com/HuiHuanYe/dsh-archived-session-delete>
- 问题反馈：<https://github.com/HuiHuanYe/dsh-archived-session-delete/issues>

## 目录

- [功能特性](#功能特性)
- [安装](#安装)
- [使用](#使用)
- [工作原理](#工作原理)
- [删除范围](#删除范围)
- [安全设计](#安全设计)
- [错误与提示](#错误与提示)
- [已知限制](#已知限制)
- [兼容性](#兼容性)
- [开发与测试](#开发与测试)
- [验证记录](#验证记录)
- [项目结构](#项目结构)
- [许可证](#许可证)

## 功能特性

- **只在归档会话上出现**：未归档会话的右键菜单不会多出这一行；菜单项使用 DSH 原生菜单服务贡献，
  自动获得键盘导航、焦点管理、危险色、分隔线和图标位；Host 端还会再次校验归档集合（前端隐藏不是唯一防线）。
- **二次确认**：确认框说明「永久删除、无法撤销」，默认聚焦「取消」，支持 Esc / 遮罩关闭与焦点循环。
- **真正删除数据**：删除权威会话日志目录（含历史格式代际）、子会话日志、`workspace` 归档登记、
  `session_projcache` 投影缓存记录，并广播 `api-session/removed` 让所有已连接页面即时移除该行。
- **子会话先删、fork 不跟随**：只跟随 `origin: 'subagent'` 的 descendant；fork 共享 lineage 字段但属于
  独立会话，不会被连带删除。子会话失败时保留其祖先，便于重试。
- **危险操作前先做完整预检**：持有会话写声明后才执行删除；会话仍被写入占用、有运行中的后台任务、
  有活动定时任务、任务目录读取失败、或存储目录里出现插件不认识的文件时，一律拒绝，不删除任何东西。
- **失败关闭而非猜测**：只删除持久化服务自己报告的会话日志位置；路径做结构校验，`stat` 不可读时再用
  `open(read)` 区分「确实不存在」与「头损坏/未落盘」，后者拒绝。
- **中英双语**：菜单、确认框、错误提示与成功 Toast 均随 DSH 语言切换。
- **不新增 agent 工具**：永久删除是不可撤销的用户授权操作，只保留用户手势入口，模型无法调用。

## 安装

这是一个标准 DSH Bundle，无构建步骤、无运行时依赖（只用 Node 内置模块）。

### 方式一：从 GitHub 克隆后安装（推荐）

```powershell
git clone https://github.com/HuiHuanYe/dsh-archived-session-delete.git
```

然后在 **DSH → 设置 → 插件 → 从目录安装** 中选择克隆目录；或在 CLI profile 中执行：

```powershell
dsh plugin --profile <profile> add 'link:<克隆目录绝对路径>'
```

> 桌面 profile（`desktop`）由 Electron 应用独占管理，`dsh plugin` 不能直接改它，请在插件页安装。

### 方式二：直接安装 GitHub 仓库

插件管理器/CLI 可访问 GitHub 时：

```powershell
dsh plugin --profile <profile> add github:HuiHuanYe/dsh-archived-session-delete
```

### 方式三：本地开发目录

直接把本仓库目录交给插件管理器（`install_bundle`，target 为该目录绝对路径）。

> **生效方式**：安装后如果 Host 没有热加载（首次安装新 Bundle 时常需要发布运行时包解析），
> 重启一次 DSH 即可。重启后 Host 行与浏览器半边会自动加载，无需额外配置。
> 在全新的隔离 profile 中已验证：全新启动即可正常加载并完成删除。

### 卸载

在插件页选中该 Bundle 并移除即可（`remove_bundle` 或 `dsh plugin --profile <profile> remove
dsh-archived-session-delete`）。卸载不会恢复已删除的会话。

## 使用

1. 侧边栏 **视图选项 → 会话筛选**，选择 **全部对话（显示已归档）** 或 **仅显示已归档**。
   （默认的「隐藏已归档」模式下看不到归档行，自然也没有删除入口。）
2. 右键任意灰色归档会话，或点击该行尾部的 `⋯`。
3. 选择 **删除归档会话**。
4. 确认框会显示会话标题和删除范围，点击 **永久删除**。
5. 成功后会显示释放空间的提示，该行从列表消失；失败会保留对话框并给出具体原因。

## 工作原理

```
右键「删除归档会话」
        │
        ▼
Client: 打开确认框 ──取消/关闭──▶ 结束
        │ 确认
        ▼
POST /api/archived-sessions.delete   (仅已认证 owner Peer)
        │
        ▼
Host: 规划阶段（不修改任何文件）
  1. 校验目标在 registry-global 归档集合中（Host 侧权威校验）
  2. traceSession 收集子会话；只收 origin=subagent，fork 及其子树排除
  3. 逐个 stat(id).location 取权威路径并结构校验；stat 不可读时用 read open 区分
     「确实不存在」与「头损坏/未落盘」，后者拒绝
  4. 逐个 open(id, 'write') 并一直持有：阻断后续 open/resume，再检查 jobs / schedule
        │
        ▼
Host: 执行阶段
  1. 子会话优先、逐层向上；某个子会话失败则阻塞其祖先，保证可重试
  2. 删除前再次校验目录，然后在持有写声明的情况下删除权威目录
  3. 清 workspace 归档登记、session_projcache 投影缓存
  4. emit api-session/removed（每个被删会话），释放全部写声明
        │
        ▼
Client: 成功 Toast；会话目录订阅到 removed 事件后移除该行
```

- **Host 半**（`index.js` + `lib/session-delete.js`）：在 `ctx.connection.fetch` 的 `/api` 认证通道上
  注册精确路由，不新增监听端口，也不暴露无鉴权入口。
- **Client 半**（`client.js`）：通过 `ctx.contextMenus.register({ target: 'session' })` 结构化贡献菜单项，
  通过 `shell.overlay` 渲染确认框与 Toast；只依赖 React，不引入其他 Harness Client 包。

## 删除范围

| 项目 | 处理方式 |
|---|---|
| 会话日志目录（当前 + 历史格式代际文件） | ✅ 删除 |
| 子会话（subagent）日志目录 | ✅ 递归收集后一并删除 |
| `workspace` 注册表中的归档登记 | ✅ 清除 |
| `session_projcache` 派生投影缓存记录 | ✅ 校验记录形状后删除 |
| 附件（`attachment-local` 内容寻址仓库） | ⛔ 保留：可能被多个会话共享，且当前没有删除 API |
| SQLite 全文搜索索引（`session-query-sqlite`） | ⛔ 保留：派生库，下次搜索时自动对账已删除源 |
| 工作区注册、浏览器本地排序/草稿 | ⛔ 保留：不属于会话数据 |

## 安全设计

| 防护 | 实现 |
|---|---|
| 调用者认证 | 路由注册在 `/api` 通道上，仅已认证的 owner Peer 可达；非 owner 返回 403 |
| 归档校验 | Host 端重新读取 registry-global 归档集合；未归档会话一律拒绝（不依赖前端隐藏） |
| 路径可信 | 只使用 `sessionPersistence.stat(id).location` 报告的路径，不按 id 拼接、不硬编码日志根目录 |
| 路径结构校验 | 绝对路径、`session[.vN].jsonl[.zstd]` 文件名、单段安全目录名、目录内仅会话代际文件与 `session.lock` |
| 失败关闭 | 目录内出现任何不认识的条目 → `storage-unexpected-entry`，放弃删除而不是递归清空 |
| 写入竞争 | 规划阶段 `open(id,'write')` 后**一直持有**写声明直到删除结束；其他 open/resume 被拒绝，不会出现「删除时又被追加」 |
| TOCTOU 收窄 | 删除前再次校验目录；权威目录原地删除（不做 staging 改名，避免残留目录污染 `sessionPersistence.list()`） |
| 子会话范围 | 仅 `origin: 'subagent'` 的 descendant 跟随删除；fork 共享 lineage 字段但属于独立会话，不跟随、也不递归其子树 |
| 缺失判定 | `stat()===undefined` 时用 read open 复核：确实不存在才按「已删除」处理；头损坏、未落盘分别拒绝 |
| 运行中工作 | `jobs.list(sessionId)` 有 running/stopping → 拒绝；`schedule.catalog()` 中非 `new` 目标且 `sessionId` 命中 → 拒绝；两个目录读取失败都**失败关闭** |
| 部分失败顺序 | 子会话先删、祖先后删；任何子会话失败会阻塞其祖先，避免父日志先消失导致子日志不可达、无法重试 |
| 旧格式保护 | `formatStatus: migration-required` 的会话直接拒绝，避免删除动作触发写迁移 |
| 并发删除 | Host 按会话 id 维护 in-flight 集合，重复请求返回 `delete-busy` |
| 请求体限制 | `content-length` 超 64 KiB 时在解码前拒绝；解析后再校验一次长度 |
| 超时与挂起 | 浏览器端 30 秒超时后中止请求，并提示「删除可能仍在后台进行」，不会让确认框永久停留在「正在删除」 |

## 错误与提示

| Host 错误码 | 界面提示（中文） | 建议 |
|---|---|---|
| `session-not-archived` | 只能删除已归档的会话 | 切换到归档视图后重试；Host 会做权威校验 |
| `session-pending` | 该会话还没有落盘，暂不能删除 | 先在该会话发送一条消息使其落盘 |
| `session-in-use` | 该会话仍在使用中 | 关闭打开该会话的页面，稍后重试 |
| `session-scheduled` | 该会话还有活动中的定时任务 | 先暂停或删除这些任务 |
| `session-jobs-running` | 该会话还有运行中的后台任务 | 等待结束或先停止任务 |
| `work-check-unavailable` | 无法确认是否仍有运行中的任务，已中止删除 | 稍后重试；Host 无法读取任务目录时不会冒险删除 |
| `lineage-unavailable` | 无法确认该会话的子会话范围，已中止删除 | 稍后重试；避免产生不可达的孤儿子会话日志 |
| `storage-migration-required` | 该会话仍使用旧版存储格式 | 暂不能直接删除 |
| `storage-unsupported` | 当前存储后端不支持安全删除 | 会话索引存在但无法安全定位/解释其日志，查看 Host 日志 |
| `storage-unexpected-entry` | 会话目录中存在本插件不会删除的文件 | 已放弃删除；可先手动检查该目录 |
| `delete-busy` | 该会话已有一个删除操作在进行 | 等待本次操作结束 |
| `invalid-request` | 删除请求不合法 | 刷新页面后重试 |
| `delete-partial` | 部分会话文件删除失败 | 稍后重试；已删除的部分会实时反映，祖先会话会保留以便重试 |
| `session-not-found` | 会话已不存在 | 按「已删除」处理，并清理残留归档登记 |

## 已知限制

- **未落盘会话不可删除**：新建后还没有任何消息的会话只存在于进程内（`sessionPersistence.stat()` 无
  `location`），删除它无法保证不会「复活」，因此返回 `session-pending`。先发送一条消息落盘即可删除。
- **部分失败保留祖先**：某个子会话删除失败时，其祖先（含根会话）会被保留以便重试；已删除的子会话
  不会复活。极端 I/O 失败后的半删除残留需要再次重试或手动清理。
- **附件不回收**：`attachment-local` 是内容寻址仓库，同一附件可能被多个会话引用，当前服务没有删除 API；
  删除会话只移除日志并清掉投影缓存，附件对象留给 DSH 自己的保留策略。
- **搜索索引延迟对账**：SQLite FTS 是派生索引，`sessionQuery` 在下一次稳定观测时对账已删除源；
  删除后立刻搜索不会再返回该会话（源文件已不存在）。
- **旧格式会话**：`formatStatus: migration-required` 的历史日志会拒绝删除并给出提示。
- **超时后仍可能完成**：浏览器 30 秒超时只是中止请求；Host 通过预检后会把删除执行到底，超时提示不代表
  失败，稍后刷新列表确认即可。
- **工作区本地界面状态**：浏览器里的本地排序/展开状态可能短暂保留一个已删除 id，刷新后消失。
- **请求体上限是处理侧限制**：64 KiB 上限阻止 handler 解码/解析超大字符串；`/api` 桥接层自身仍有
  ~300 MiB 的缓冲上限，且该路由只对已认证 owner 开放。
- **仅 Web / 桌面 Web GUI**：依赖 `connection.fetch`、`contextMenus` 与 `shell.overlay` 客户端席位。

## 兼容性

| 项目 | 说明 |
|---|---|
| DSH | 0.2.2-rc.1（已验证）；使用公开的 `connection.fetch` / `contextMenus` / `slots` / `locale` 接口 |
| Node.js | ≥ 24（仅使用内置 `node:fs`、`node:path`、`node:os`） |
| 平台 | Windows（已实测）；其他平台未实测，但未使用平台专属 API |
| 必需服务 | `connection`、`sessionPersistence`、`workspaceRegistry`（提供归档集合）；可选 `sessionQuery`（子会话发现）、`jobs`、`schedule`（工作检查） |
| 会话存储 | 要求会话有持久化 artifact（当前为 `session-persistence-jsonl`）；未落盘会话按 `session-pending` 拒绝 |
| 构建 | 无（纯 ESM + 浏览器原生 JS） |

## 开发与测试

```powershell
git clone https://github.com/HuiHuanYe/dsh-archived-session-delete.git
cd dsh-archived-session-delete

npm run check   # node --check 三个运行时文件
npm test        # 35 个 node:test 用例
# 等价手动命令：
# node --test test/session-delete.test.mjs test/host-route.test.mjs test/client-wiring.test.mjs
```

| 测试文件 | 覆盖内容 |
|---|---|
| `test/session-delete.test.mjs` | 请求校验、路径分类、目录清点、未知文件拒绝、删除前重新校验、空目录、投影缓存核实 |
| `test/host-route.test.mjs` | 认证路由端到端（假 Cordis ctx + 真实临时文件系统）、子会话、归档/缓存清理、各种拒绝路径、并发、请求体上限 |
| `test/client-wiring.test.mjs` | 菜单贡献的可见性/权限、确认框、成功 Toast、结构化失败、已不存在、超时 |

当前共 **35** 个 `node:test` 用例全部通过。测试不需要 DSH 运行中的实例，也不会触碰真实会话数据。

## 验证记录

<details>
<summary>展开：隔离 profile 的真实服务端到端验证</summary>

在独立 `DSH_HOME`（不触碰真实会话数据）中：

1. 从官方 `web` 模板创建 `verify` profile → 用 `dsh plugin` 安装本 Bundle → `--dump-config` 出现
   `archived-session-delete` 行。
2. 启动独立 Web Host：index 的 boot graph 含 `dsh-archived-session-delete`，
   `plugins/??dsh-archived-session-delete/client.js&rev=…` 返回 200 且内容为本插件。
3. 把真实会话日志**复制**进隔离目录后：
   - 对未归档会话调用删除路由 → 409 `session-not-archived`（Host 侧权威校验生效，未触碰文件）；
   - 通过真实 `workspace/archiveSession` RPC 归档后再次调用 → 200，677,485 B 的日志目录被删除，
     无 staging/残留，持有中的写声明正常释放；
   - 先把已归档会话的 artifact 手动删除、再请求删除 → 200 `alreadyGone`，归档登记被清理。
4. 目录混入未知文件时返回 409 `storage-unexpected-entry` 且不删除；非法 id 返回 400；
   无认证请求被 `/api` 认证层拒绝。
5. 真实桌面 profile：安装成功；重启 DSH 后插件已在运行界面注册（`shell.overlay` 占位 active），
   并在真实界面中实际删除了归档会话（归档集合与磁盘日志目录同步减少）。

</details>

## 项目结构

```text
dsh-archived-session-delete/
├── index.js                  # Host 半：认证路由、删除编排、归档/缓存清理、客户端通知
├── lib/session-delete.js     # 持久化路径校验与文件操作（可单测，无 Cordis 依赖）
├── client.js                 # 浏览器半：菜单贡献、确认框、Toast、中英文案
├── cordis.patch.yml          # Bundle patch：插入 Host 行
├── package.json              # Bundle/Client 声明与插件元数据
├── locale/{en,zh}.json       # 插件显示名与描述
├── icon.svg                  # 插件图标
├── test/                     # node:test 测试（35 个用例）
├── LICENSE                   # MIT
└── README.md
```

## 许可证

[MIT](LICENSE) © 2026 dsh-archived-session-delete contributors

