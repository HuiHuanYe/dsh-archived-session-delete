# dsh-archived-session-delete — 归档会话删除

GitHub: <https://github.com/HuiHuanYe/dsh-archived-session-delete> · MIT License

DSH Web 侧边栏插件的持久化 Bundle：在**归档会话**的右键菜单（以及行尾 “⋯” 菜单）中增加一个
**删除归档会话** 操作，带二次确认，删除后会永久清除该会话在本机的对话日志。

> DSH 自带的归档只能“藏起来”，界面明确不提供删除。本插件补上这一条，其余交互保持官方风格：
> 原生菜单行、危险色、分隔线、图标位、键盘导航、Esc/焦点管理、深浅色主题令牌。

## 功能

- 只对**已归档**的会话显示菜单项（未归档会话菜单不会多出这一行）。
- 点击后弹出确认框，说明“永久删除、无法撤销”，确认按钮为危险色。
- Host 端执行真正删除：
  1. 校验会话仍在、未被写入者占用（通过 `sessionPersistence.open(id, 'write')` 独占声明探测）；
  2. 拒绝仍有运行中后台任务或**活动定时任务**指向该会话的删除；
  3. 递归收集其**子会话（subagent）**，一并删除（父日志删除后子日志不可达）；
  4. 只删除权威日志位置（`sessionPersistence.stat(id).location`）所在的、仅包含会话代际文件与写锁的
     会话所属目录，遇到任何未知文件一律**放弃删除**而不是猜测；
  5. 清除 `workspace` 注册表里的归档条目；
  6. 尽力清除 `session_projcache` 派生投影缓存记录（校验记录形状后才删）；
  7. 通过 `api-session/removed` 事件通知所有已连接页面把该行从会话目录中移除，列表即时刷新。
- 成功提示会报告释放的空间；失败按原因本地化提示（被占用 / 有定时任务 / 旧格式 / 未知文件等）。

## 设计取舍

- **平台原生菜单扩展**：使用 `ctx.contextMenus.register({ target: 'session' })` 结构化贡献，而不是
  自绘菜单行；菜单的键鼠、焦点、危险色、图标对齐全部由 DSH 负责。
- **认证通道**：Host 端通过 `ctx.connection.fetch.register` 在 `/api` 认证通道上注册
  `POST /api/archived-sessions.delete`，仅接受已认证的 owner Peer（浏览器 Cookie）；不新增监听端口、
  不暴露无鉴权路由。
- **不新增 agent 工具**：永久删除是不可撤销的用户授权操作，只保留用户手势入口，不允许模型或外部调用。
- **只信持久化服务给出的位置**：不硬编码 `sessions/` 根目录，也不按 id 拼接路径；路径先做结构校验
  （绝对路径、`session[.vN].jsonl[.zstd]` 文件名、单段安全目录名、目录内仅会话文件与 `session.lock`）
  才执行 `rm`。
- **派生数据自愈**：SQLite 搜索索引是派生库，会在下一次搜索时自动对账删除源；附件是内容寻址、
  可能跨会话共享，不做猜测性删除（见“已知限制”）。

## 安装

插件是标准的本地 Bundle，仓库地址 <https://github.com/HuiHuanYe/dsh-archived-session-delete>。任选其一：

1. **从 GitHub 克隆后安装**：

   ```powershell
   git clone https://github.com/HuiHuanYe/dsh-archived-session-delete.git
   ```

   然后在 DSH → 设置 → 插件 → 从目录安装中选择克隆目录；或在 CLI profile 中执行
   `dsh plugin --profile <name> add 'link:<克隆目录绝对路径>'`
   （桌面 profile 由 Electron 应用独占管理，请用插件页安装）。

2. **直接安装 GitHub 仓库**（插件管理器或 CLI 可访问 GitHub 时）：
   `dsh plugin --profile <name> add github:HuiHuanYe/dsh-archived-session-delete`

3. **本机开发目录**：直接选择本仓库目录安装（`install_bundle` / 插件页“从目录安装”）。

> **生效需要重启一次 DSH。** 当前桌面 profile 在安装时返回 `application: restart-required`
> （该 profile 的运行时包解析发布被 DSH 以 `package-moved` 拒绝；DSH 对新 Bundle 的提示也是重启后再加载）。
> 退出并重新打开 DSH 后，Host 行与浏览器半边会自动加载，无需再做任何配置。
> 在隔离 profile 的全新启动中已用相同安装方式验证插件可正常加载（见“验证记录”）。

## 使用

1. 侧边栏视图选项 → 会话筛选 → **全部对话（显示已归档）** 或 **仅显示已归档**。
2. 右键任意灰色归档会话（或点行尾 “⋯”）。
3. 选择 **删除归档会话** → 在确认框点 **永久删除**。

## 已知限制

- **附件不回收**：`attachment-local` 是内容寻址仓库，同一附件可能被多个会话引用，当前服务没有删除 API；
  删除会话只移除日志并清掉投影缓存，附件对象留给 DSH 自己的保留策略。
- **搜索索引延迟对账**：SQLite FTS 是派生索引，`sessionQuery` 在下一次稳定观测时对账已删除源；
  删除后立刻搜索不会再返回该会话（源文件已不存在）。
- **旧格式会话**：`formatStatus: migration-required` 的历史日志会拒绝删除并给出提示，避免删除动作
  触发写迁移。
- **活动中的会话**：被写入者占用（运行中或前端已打开）时拒绝删除，这是有意的安全行为。
- **仅 Web/桌面 Web GUI 运行时**：依赖 `connection.fetch` 与 `shell.overlay`/`contextMenus` 客户端席位。

## 验证记录

已完成（本会话内）：

- `node --test`：3 个测试文件、21 个用例全部通过，覆盖请求校验、路径安全分类、目录清点与删除、
  未知文件拒绝、投影缓存记录核实、Host 路由端到端（假 Cordis ctx + 真实临时文件系统）、
  客户端菜单解析 / 弹窗 / 成功 Toast / 结构化失败 / “已不存在”分支。
- 独立 profile 的真实服务端到端（隔离 `DSH_HOME`，不触碰真实会话数据）：
  - 从官方 `web` 模板创建 `verify` profile → 用 `dsh plugin` 安装本 Bundle → `--dump-config` 出现
    `archived-session-delete` 行；
  - 启动独立 Web Host：index 的 boot graph 含 `dsh-archived-session-delete`，
    `plugins/??dsh-archived-session-delete/client.js&rev=…` 返回 200 且内容为本插件；
  - 把真实归档会话日志**复制**进隔离目录后调用认证路由：`POST /api/archived-sessions.delete` 返回 200，
    对应 610,689 B 与 827,035 B 的会话目录被删除；
  - 目录混入未知文件时返回 409 `storage-unexpected-entry` 且不删除；清理后重试返回 200；
  - 不存在的会话返回 200 `alreadyGone`；非法 id 返回 400；无认证请求被 `/api` 认证层拒绝。
- 真实桌面 profile：安装成功并已选中（`application: restart-required`）。DSH 对该 profile 的运行时解析
  发布返回 `package-moved`，因此**需重启一次 DSH** 才会在真实界面加载；重启后的视觉验证未能在本会话完成。

## 开发与验证

```powershell
node --check index.js
node --check client.js
node --test test/session-delete.test.mjs test/host-route.test.mjs test/client-wiring.test.mjs
```

测试覆盖：请求校验、日志路径分类、目录清点与删除、未知文件拒绝、投影缓存记录的核实与删除，
以及 Host 路由（假 Cordis ctx + 真实临时文件系统）与客户端菜单/弹窗/Toast 流程。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：认证路由、删除编排、归档/缓存清理、客户端通知 |
| `lib/session-delete.js` | 可单测的持久化路径校验与文件操作 |
| `client.js` | 浏览器半：会话右键菜单行、确认框、Toast、中英文本 |
| `cordis.patch.yml` | Bundle patch：插入 Host 行 |
| `locale/*.json` | 插件显示名与描述（Plugin Manager / 设置页） |
| `icon.svg` | 插件图标 |
| `test/session-delete.test.mjs` | 持久化路径/文件操作单元测试 |
| `test/host-route.test.mjs` | Host 认证路由端到端测试 |
| `test/client-wiring.test.mjs` | 客户端菜单与弹窗流程测试 |

## 许可证

[MIT](LICENSE) © 2026 dsh-archived-session-delete contributors

