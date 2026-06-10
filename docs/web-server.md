# Quill Web 端与服务端架构

> 范围：在现有桌面端之外引入 Web 客户端（PC + H5）与自部署 Docker 服务端的设计。
> 本文先定**形态、接口、协议、同步模型、配置格式**，具体实现细节落到代码时再定。
> 与 `architecture.md` 互补：那篇描述桌面端现状，本文描述演进后的多端协同形态。

## 目标 / 非目标

**目标**
- 用户自部署一个 Docker 服务，桌面端 / PC web / H5 三端连同一份 vault
- H5 在 iOS Safari 上能用（这是不能走 File System Access 路线的根因）
- AI Agent 三端都能用：桌面端跑本地，Web 端走 server 代理
- 不引入多用户、不引入冲突自动合并，保持单人自部署的简单度

**非目标（本期不做）**
- PC web 的本地文件模式（接口预留，后续再做）
- 多用户 / 多租户 / 权限模型
- 整库自动同步（手动 pull/push 即可）
- rename 追踪、合并算法、操作日志
- 端到端加密、二次验证

## 整体架构

```
桌面端
 ├─ 本地模式 (现状) ──→ 本机磁盘 + 本地 agent (本地密钥)
 └─ 远程模式 ─────────┐
                      │
PC web ───────────────┼──→ Docker Server
H5 ───────────────────┘    ├─ /api/auth    单密码登录
                           ├─ /api/vault/* 文件 CRUD + 索引
                           ├─ /api/agent   AI agent (WebSocket)
                           ├─ /              静态资源 (web 前端)
                           └─ vault/         挂载用户数据卷
```

**核心约束**：本地模式和远程模式在桌面端**互斥切换**（workspace switcher），不混在同一棵文件树里。Web 端今天只有远程模式。

## 客户端矩阵

| | 桌面端（本地） | 桌面端（远程） | PC web | H5 |
|---|---|---|---|---|
| 文件存储 | 本机磁盘 | server vault（拉到本地缓存） | server vault | server vault |
| AI Agent | 本地（main 进程） | 本地（main 进程） | server 代理 | server 代理 |
| 密钥来源 | `providers.ts` | `providers.ts` | `config.yaml` | `config.yaml` |
| 离线编辑 | ✅ 完全本地 | ✅ 已拉取的文件 | ❌ | ❌ |
| 文件状态图标 | 不需要 | 需要（同步状态） | 不需要 | 不需要 |

## 共享包重构

```
packages/
├── core/              纯 UI 内核：编辑器、预览、Markdown、主题（无 Electron / DOM-only 依赖）
├── agent/             agent 运行时：循环、工具、压缩、provider 抽象（无 Electron）
├── vault-adapter/     VaultProvider 接口 + 三个实现（Local / Remote / FileSystemAccess）
└── shared-types/      跨端共享的 TS 类型
```

**抽取顺序**（每步都能跑通）：

1. `packages/shared-types` 先建，把现在散在 `preload/index.ts` 里的类型（`FileNode`、`Scope`、`HistoryMessage` 等）挪过来
2. `packages/agent` 从 `apps/desktop/src/main/agent/` 抽：把对 `ipcMain.handle` / Electron `net` / `providers.ts` 的直接调用换成接口注入（见下文「Agent 抽取边界」）
3. `packages/vault-adapter` 定义接口 + `LocalProvider`（包桌面端 IPC）+ `RemoteProvider`（包 HTTP/WebSocket）。`FileSystemAccessProvider` 预留位置不实现
4. `packages/core` 抽 renderer 里 UI 组件——这步最大，最后做
5. `apps/server` 起 Bun + Hono 工程，引用 `packages/agent` + `packages/vault-adapter`（server 侧 vault 直接操作本地 fs）
6. `apps/web` 起 Vite + React 工程，引用 `packages/core` + `packages/vault-adapter`（用 RemoteProvider）

## VaultProvider 接口

放在 `packages/vault-adapter/src/types.ts`：

```ts
export type VaultEntry = {
  path: string           // 相对 vault 根目录的 POSIX 路径
  isDirectory: boolean
  size?: number
  mtime?: number
  hash?: string          // 仅文件，内容 SHA-256
}

export type SyncStatus =
  | 'cloud-only'         // ☁️  server 有，本地没拉过
  | 'synced'             // ✓   本地 == 云端
  | 'local-modified'     // ●   本地动过
  | 'remote-modified'    // ↓   云端动过
  | 'conflict'           // ⚠️   两边都改了
  | 'local-only'         // ＋  仅本地，还没推
  | 'local-deleted'      // 🗑   本地删了，server 还在，等待 push 同步
  | 'remote-deleted'     // ✗   云端删了，本地还在

export interface VaultProvider {
  readonly kind: 'local' | 'remote' | 'fs-access'

  // 基础 CRUD
  list(dir: string): Promise<VaultEntry[]>          // 列单层目录（不递归）
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>  // 父目录不存在时自动 mkdir -p
  rename(oldPath: string, newPath: string): Promise<void>
  delete(path: string): Promise<void>               // 文件或空目录
  deleteDir(path: string, recursive: boolean): Promise<void>  // 删非空目录必须 recursive: true
  stat(path: string): Promise<VaultEntry>
  exists(path: string): Promise<boolean>

  // 目录
  mkdir(path: string): Promise<void>                // 创建空目录，父目录自动 mkdir -p

  // 同步（仅 remote 实现，其它返回 'synced' 或 throw NotSupported）
  syncStatus(path: string): Promise<SyncStatus>
  syncIndex(): Promise<Map<string, SyncStatus>>   // 全量扫描，刷新侧栏图标
  pull(path: string): Promise<void>               // cloud-only / remote-modified → synced
  push(path: string): Promise<void>               // local-modified / local-only → synced
  resolveConflict(path: string, keep: 'local' | 'remote'): Promise<void>

  // 资源 URL（图片 src 解析）
  resourceUrl(path: string): string | Promise<string>
}
```

**关键设计点**：
- `syncStatus` 是 provider 内部职责，不是 UI 自己算的——UI 只渲染状态图标
- `RemoteProvider` 维护本地的 `.quill-sync.json` 索引：`{ path: { hashAtLastSync, mtimeAtLastSync, pendingDelete?: true } }`。本地删除的文件保留索引条目并打 `pendingDelete`，push 时把这些 tombstone 一起同步到 server，成功后才清掉条目
- `Local` 和 `FileSystemAccess` 的 `syncStatus` 永远返回 `'synced'`（不参与同步流程）

## 同步模型

**手动触发，hash 判定，永不静默覆盖**。

### 状态计算

打开 vault 时：
1. 扫描本地缓存目录得到 `localMap: { path -> currentHash }`
2. 拉 `GET /api/vault/index` 得到 `remoteMap: { path -> remoteHash }`
3. 读本地 `.quill-sync.json` 得到 `lastSyncMap: { path -> hashAtLastSync }`
4. 三方比对：

```
                远端有?         本地有?      上次 sync 时 hash 与现在的关系
cloud-only       ✓               ✗           lastSync 中无此条目
synced           ✓               ✓           local == remote == lastSync
local-modified   ✓               ✓           local ≠ lastSync, remote == lastSync
remote-modified  ✓               ✓           local == lastSync, remote ≠ lastSync
conflict         ✓               ✓           local ≠ lastSync, remote ≠ lastSync
local-only       ✗               ✓           lastSync 中无此条目
local-deleted    ✓               ✗           lastSync 中有此条目（标记为待删）
remote-deleted   ✗               ✓           lastSync 中有此条目
```

### 操作

- **pull(path)**：`GET /api/vault/file/<path>` → 写本地 → 更新 `.quill-sync.json[path] = { hashAtLastSync: 新hash }`
- **push(path)**：
  - 文件新建/修改：`PUT /api/vault/file/<path>` 带 `If-Match: <expectedRemoteHash>` 头 → 成功后更新索引
  - 文件删除（`pendingDelete`）：`DELETE /api/vault/file/<path>` 带 `If-Match` → 成功后从索引移除条目
  - 412 Precondition Failed 说明远端在你之间被改过，转为 `conflict` 状态
- **resolveConflict**：用户选保留哪边。**被覆盖的那份不真删**，先备份成 `<path>.conflict-<ISO时间>.md`，永远走显式删除

### 推送时机

仅手动。保存（⌘S）只写本地缓存，**不自动 push**。侧栏上 `local-modified` 条目旁有"上传"按钮；也提供"上传所有改动"全局按钮。

### 边界处理

- **重命名/移动**：不追踪 rename，按"旧路径删 + 新路径加"处理
- **目录**：目录本身不算 hash，但**空目录也纳入索引**（`isDirectory: true` 条目）。
  这样桌面端新建的空文件夹能 push 上去，server 上的空文件夹也能 pull 下来。
  目录的同步状态只有三种：`synced` / `local-only` / `remote-deleted`（不会有"已修改"）。
- **二进制资源**（图片）：纳入同步，但状态简化成"有/无"（hash 仍然算，但 UI 不显示"已修改"——用户不会编辑二进制）

## Server API

Bun + Hono。所有 `/api/*` 需要登录后的 cookie。

### 鉴权

```
POST /api/auth/login        { password }  → 200 { token } + Set-Cookie: quill-session=...
POST /api/auth/logout
GET  /api/auth/me           → 200 { authenticated: true } | 401
```

- 单密码，密码哈希存 `config.yaml`（启动时校验明文，不入库）
- Token 用 HS256 签 + httpOnly cookie，TTL 默认 30 天，可配
- 暴力破解防护：固定 IP 5 次失败后 60s 冷却（够用）

### Vault

```
GET    /api/vault/index                    → [{ path, isDirectory, size, mtime, hash }]
GET    /api/vault/list?dir=<path>          → 单层列表，配懒加载文件树用
GET    /api/vault/file/<path>              → 文件原文 + ETag: <hash>
PUT    /api/vault/file/<path>              请求体: 文件原文
                                            可选 If-Match: <hash>（不匹配则 412）
                                            父目录不存在时自动 mkdir -p
                                            响应: { hash: <newHash> }
DELETE /api/vault/file/<path>              可选 If-Match；只能删文件
POST   /api/vault/mkdir                    { path }  创建空目录（父级自动 mkdir -p）
DELETE /api/vault/dir/<path>?recursive=1   删目录；recursive=0（默认）时仅删空目录
POST   /api/vault/move                     { from, to }  文件或目录都可
GET    /api/vault/resource/<path>          二进制资源直出（图片等），带强 ETag + Cache-Control
```

**目录删除安全约束**：`recursive=true` 的请求会进 server 日志，并在响应里返回被删除的子项列表，便于客户端做"撤销/查看"提示。

**路径规范**：URL 里的 `<path>` 必须是 vault 根的相对路径，server 端做 `path.normalize` + 防 `..` 越权检查。

### Sync spaces（文件夹工作区同步注册表）

桌面端「文件夹工作区云同步」（#109）用的空间注册表。记录哪些本地文件夹开启过同步、
对应 vault 根下哪个目录；换电脑连同一服务器即可发现并拉取。存
`STATE_DIR/sync-spaces.json`，是 server 状态而非 vault 内容。

```
GET    /api/sync/spaces        → [{ id, name, remotePath, createdAt }]
POST   /api/sync/spaces        { name, remotePath }；remotePath 重复 → 409，越权路径 → 400
DELETE /api/sync/spaces/<id>   只删注册表记录，不动任何文件
```

配套约定：vault 扫描（/index、/list）跳过 `.quill/` —— 桌面端在工作区文件夹内的
`.quill/sync.json` 里存绑定关系 + 上次同步的 hash 索引，同步元数据本身不上云。

### Agent

WebSocket，端点 `/api/agent`。一条连接对应一个浏览器会话，支持多个并发 run。

```
client → server:
  { type: 'run',          runId, args: AgentRunArgs }
  { type: 'cancel',       runId }
  { type: 'approval',     runId, toolCallId, response: { approved, reason? } }
  { type: 'plan-approval',runId, response: PlanApprovalResponse }

server → client:
  { type: 'event', runId, event: AgentEvent }       // text-delta / tool-call / ...
```

`AgentRunArgs` / `AgentEvent` 复用 `packages/shared-types`，跟现在桌面端 IPC 用的是同一份类型。

## 工作区与目录操作

vault 是一棵任意深度的目录树，跟用户本地文件系统一一对应。所有客户端（桌面、PC web、H5）都要支持下列动作。

### 文件树展示

- 侧栏文件树**懒加载**：默认只展开根目录，点击文件夹节点时再调 `list(dir)` 拉子层。大 vault 不会一次性扫完。
- 远程模式下，每个节点显示同步状态图标（见 [同步模型](#同步模型) 的 7 种状态）。
- 排序：目录在前，文件在后，各自按名字字典序。

### 创建操作

| 操作 | 入口 | 行为 |
|---|---|---|
| 在根目录新建文件 | 工具栏 ➕ 按钮 / ⌘N | 弹输入框 → 调 `write(path, '')` |
| 在根目录新建文件夹 | 工具栏 📁+ 按钮 | 弹输入框 → 调 `mkdir(path)` |
| 在某文件夹下新建文件 | 右键节点 → "新建文件" / 长按（H5） | 在该目录下创建 |
| 在某文件夹下新建文件夹 | 右键节点 → "新建文件夹" / 长按（H5） | 嵌套创建 |
| 创建多层路径（如 `a/b/c.md`） | 输入名字时直接打斜杠 | `write` / `mkdir` 自动 `mkdir -p` 中间层 |

### 远程模式下的待推送状态

- 新建的文件/文件夹立即出现在树里，标记为 `local-only`（＋ 图标）
- 用户**没点"上传"前 server 不知道这个新条目存在**——这是手动同步的核心约束
- 提供"上传所有改动"全局按钮一键 push 所有 `local-only` / `local-modified` 条目

### 移动 / 重命名

- 通过 `rename(oldPath, newPath)` 实现，远程模式下走 `POST /api/vault/move`
- **不追踪**：rename 之后目标路径变成 `local-only`，原路径变成 `remote-deleted`（如果之前同步过）
- UI 上提供"重命名" / "移动到..."操作，H5 上是长按菜单

### 删除

- 删文件：直接 `delete(path)`
- 删文件夹：默认弹确认框，**显式选"递归删除"**才会递归，避免误删整个子树
- 远程模式下，删除操作在用户**显式 push** 时才同步到 server——本地缓存里立即消失，但 server 还在。在文件树底部的"待同步"分组里显示为 🗑 `local-deleted` 条目，用户可以选择 push（确认删除）或 pull（恢复）

## UI 一致性

**Web 端（PC + H5）的视觉、字体、交互细节必须跟桌面端保持一致**，让用户在三端之间切换没有割裂感。落地上有两层：共享底层 + 端侧自适应。

### 设计语言（不变量）

桌面端现在用的是 **Paper · 纸感编辑器** 主题，三端共用：

| 维度 | 规范 |
|---|---|
| 色系 | `--paper / paper-dim / paper-soft / paper-edge`（四档暖白纸底）+ `--ink / ink-soft / ink-faint / ink-ghost`（墨色）；**不靠 border / shadow 分层** |
| Accent | 旧打字机红 `--accent`（`oklch(0.55 0.16 28)`），暗色变 `oklch(0.78 0.14 40)` |
| 标题字体 | Fraunces（含 SOFT/WONK 变量轴）+ Noto Serif SC |
| 正文字体 | Geist + Noto Sans SC |
| 代码字体 | JetBrains Mono / SF Mono |
| 正文段落 | Noto Serif SC（衬线），`line-height: 1.85`，配 `--ink-soft` 而非纯黑 |
| 边线 | `--rule / --rule-soft`（仅用于 table、hr、blockquote 左边线，不做卡片包边） |
| 圆角 | 6–8px，仅用于代码块、图片、按钮 |
| 主题切换 | `data-theme="light|dark"`，跟 localStorage；Web 端 + `prefers-color-scheme` 跟系统 |

### 共享物料抽取

在 `packages/core` 下建：

```
packages/core/
├── styles/
│   ├── tokens.css        从 index.css 抽出来的 :root / [data-theme="dark"] CSS 变量
│   ├── prose-paper.css   `.prose-paper` 完整规则
│   ├── prose-agent.css   `.prose-agent` 完整规则
│   ├── hljs-paper.css    highlight.js 的 paper-warm token theme
│   └── editor.css        CodeMirror 的 paper 化覆盖（active line、搜索高亮等）
└── components/
    ├── Editor.tsx        CodeMirror 6 + lang-markdown 封装
    ├── Preview.tsx       markdown-it + 套 .prose-paper
    ├── FileTree.tsx      文件树（接受 VaultProvider，渲染同步状态图标）
    ├── StatusBar.tsx     字数 + 保存状态 + 主题切换
    ├── ModeSwitcher.tsx  ✎ ⇄ 👁 三态
    ├── AgentPanel.tsx    AI agent 对话面板
    ├── ThemeToggle.tsx
    └── Select.tsx        统一的下拉/弹层
```

**桌面端的 `apps/desktop/src/renderer/src/index.css` 改成只 import 这些共享 css**，零规则定义。Web 端同样 import，行为完全一致。

**Tailwind 配置**：在 `packages/core/styles/tailwind-preset.ts` 暴露一份 preset（包括 `@theme` 配置、`prose-paper` 插件、`dark` custom variant），三个 app 的 `tailwind.config` 都 `presets: [quillPreset]`。

### 端侧自适应（变量）

虽然视觉语言一致，但跟"操作平台 / 屏幕"绑死的细节要分端实现，不能强行统一：

| 细节 | 桌面端 | PC web | H5 |
|---|---|---|---|
| 标题栏 | macOS `hiddenInset` + drag region | 浏览器原生，没有 | 同 PC web，但顶栏更高（避开刘海/状态栏） |
| 侧栏 | 固定占左侧，可折叠 | 同桌面 | **抽屉式 drawer**，默认收起，左上角汉堡按钮打开 |
| 三态切换 | ✎ ⇄ 👁 全部可用 | 同桌面 | **只保留 ✎ / 👁**——窄屏分栏没意义；默认 👁 |
| 右键菜单 | 原生 contextmenu | DOM contextmenu | **长按 500ms 弹出**自定义菜单 |
| 快捷键 | ⌘N / ⌘O / ⌘S 等 | 同桌面（无原生菜单，通过全局监听） | 不依赖快捷键，纯按钮操作 |
| 触控目标 | 32px 起步 | 同桌面 | **44px 起步**，符合 iOS HIG |
| 字号 | 编辑器 14px、正文 15px | 同桌面 | 编辑器 16px、正文 16px（移动端最小可读 + 避免 iOS Safari 自动放大输入框） |
| 滚动条 | macOS overlay | 浏览器默认 | 隐藏，靠惯性滚动 |
| 文件树 | 树形，所有层级原地展开 | 同桌面 | 同桌面，但用**面包屑 + 列**导航（VS Code Mobile 风格）做可选方案，决定前先做树形 |
| 工作区切换器 | 顶部下拉（local / remote） | 不显示（只有 remote） | 不显示 |
| 登录态 | 不需要 | 进 app 前的登录页 | 同 PC web |

H5 的自适应**通过 Tailwind 的响应式断点实现**，不写两套组件。比如：

```tsx
<aside className="
  hidden md:block            /* 默认隐藏，≥md 显示 */
  md:w-64 md:border-r        /* PC 上固定宽侧栏 */
">…</aside>

<button className="
  md:hidden                  /* 仅 H5 显示汉堡按钮 */
  text-[--ink] p-3
">☰</button>
```

只有少数地方（长按菜单 vs 右键菜单、touch event 处理）需要平台分支，用 `useIsTouch()` hook 判一下。

### 主题切换在 Web 端的差异

- 桌面端用 Electron `nativeTheme.shouldUseDarkColors` 跟系统
- Web 端用 `window.matchMedia('(prefers-color-scheme: dark)')` 跟系统
- 共享代码里抽 `useSystemTheme()` hook，两个实现走条件 import

### iOS Safari 的几个坑（先打住）

- 输入框 `font-size < 16px` 会触发自动放大 → H5 编辑器最小 16px
- `100vh` 不算 toolbar 高度 → 用 `100dvh`
- 长按文字默认弹系统菜单 → 文件树节点加 `user-select: none` + 自定义长按
- 状态栏色（PWA 装上主屏后）通过 `<meta name="theme-color">` 跟随 `--paper`/`--paper-dim` 切换

### 验收标准

桌面端任取一张截图，对应在 PC web 同样操作截一张，**像素级几乎一致**（差异限于：窗口装饰、浏览器 chrome、不在断点范围内的字号微调）。H5 上同一份内容渲染出来字体、颜色、间距比例一致，只是布局结构变窄屏。

## Agent 抽取边界

现状（`apps/desktop/src/main/agent/`）跟 Electron 紧耦合的地方：

| 当前耦合点 | 抽象成 | 桌面实现 | server 实现 |
|---|---|---|---|
| `ipcRenderer.send('agent:event', ...)` 推事件 | `EventSink` 接口 | 包 `webContents.send` | 包 WebSocket `ws.send` |
| 弹原生 dialog 等审批 | `ApprovalRequester` 接口 | 包 IPC 一来一回 | 走 WebSocket 反向消息 |
| 读 `providers.ts`（用户密钥） | `CredentialProvider` 接口 | 包 keytar / electron-store | 从 `config.yaml` 读 |
| Node `fetch` / Electron `net` | 直接用 `fetch` | 同 | 同（Bun 原生 fetch） |
| HTTP 代理设置 | `NetworkConfig` 注入 | 从 app prefs 读 | 从 `config.yaml` 读（可选） |

抽完后 `packages/agent` 的入口长这样：

```ts
export function createAgentRuntime(deps: {
  events: EventSink
  approval: ApprovalRequester
  credentials: CredentialProvider
  vault: VaultProvider          // agent 工具用它读写 vault，跟 UI 同一个实例
  network?: NetworkConfig
}): AgentRuntime
```

工具集（read / write / search / 等）也搬到 `packages/agent/tools/`，参数化 vault 实例。

## 配置文件

`config.yaml`，Docker 挂载到 `/app/config.yaml`：

```yaml
server:
  port: 3000
  base_url: "https://quill.example.com"   # 用于生成 cookie domain、跨域校验

auth:
  # 密码 bcrypt 哈希，用 `quill-server hash-password` 生成（启动脚本提供）
  password_hash: "$2b$12$..."
  session_ttl_days: 30
  rate_limit:
    max_attempts: 5
    cooldown_seconds: 60

vault:
  path: /data/vault                       # 容器内路径

ai:
  providers:                              # 可选；为空则 web 端 AI 入口隐藏
    - id: openai
      base_url: "https://api.openai.com/v1"
      api_key: "${OPENAI_API_KEY}"        # 支持从环境变量插值
      models: ["gpt-4o", "gpt-4o-mini"]
    - id: anthropic
      base_url: "https://api.anthropic.com"
      api_key: "${ANTHROPIC_API_KEY}"
      models: ["claude-opus-4-7"]
  default: "openai/gpt-4o-mini"

logging:
  level: info                             # debug | info | warn | error
  file: /data/logs/quill.log              # 不写则只输出 stdout
```

**Provider 字段**跟桌面端 `providers.ts` 里的字段一致，方便复用类型。

## 部署

```yaml
# docker-compose.yml
services:
  quill:
    image: quill-server:latest
    ports:
      - "3000:3000"
    volumes:
      - ./vault:/data/vault
      - ./config.yaml:/app/config.yaml:ro
      - ./logs:/data/logs
    environment:
      - OPENAI_API_KEY=sk-xxx
    restart: unless-stopped
```

镜像里包：
- Bun runtime
- `apps/server` 编译产物
- `apps/web` 静态产物（server 直接静态托管 `/`）

无外部依赖（数据库、redis 都不需要——索引文件、session 都用文件系统）。

## 桌面端的远程模式

### Workspace 切换器

顶部加切换器，**本地 vault** 和 **远程 vault** 互斥：

```
┌────────────────────────────────────────────────┐
│ [▼ Local: ~/notes/work]              ─ □ ✕    │
│   ◯ Local: ~/notes/work                        │
│   ◯ Local: ~/notes/journal                     │
│   ──────────────                               │
│   ◯ ☁️ Remote: quill.example.com              │
│   ──────────────                               │
│   + 添加远程 vault…                            │
└────────────────────────────────────────────────┘
```

第一版**远程只支持一个**，URL + 密码存桌面端 `electron-store`，密码进 keytar。

### 文件树状态图标

仅远程模式显示。状态图标贴在文件名右侧，hover 显示文字描述。

### 缓存目录

远程 vault 拉到本地的文件存 `<userData>/remote-cache/<server-hash>/<vault-path>`，跟用户的本地 vault 完全隔离。

## 安全要点

- `/api/vault/*path` 必须 normalize + 拒绝 `..` / 绝对路径，防止越权读 vault 之外的文件
- WebSocket 连接握手时校验 cookie，未登录直接 close 1008
- Markdown 渲染始终走 sanitizer（现在桌面端用的是 markdown-it + 白名单，server 端 web 端复用同一份）
- 上传文件大小限制（默认 50 MB / 文件），避免被传大文件塞爆磁盘
- HTTPS 由反代（Caddy / nginx）负责，server 自己只听 HTTP

## 未决问题

记下来不在本期解，避免设计被牵着走：

- **PC web 本地模式**：接口已留，做的时候加 `FileSystemAccessProvider` + 顶部"打开本地"按钮 + 动态 import
- **多 vault / 多 server**：UI 已经设计成切换器，扩成多个不难，但密码管理（多套 token）要额外考虑
- **多用户**：动它就要重做 auth 模型 + vault 隔离 + 注册流程，是另一个项目了
- **冲突 diff 视图**：先用"二选一覆盖 + 备份成 `.conflict-*.md`"兜底，之后看用户反馈再加
- **rename 追踪**：现在按"删 + 加"处理，会丢同步状态，体感能接受就不做
- **agent 跨端历史**：桌面端跑本地 agent，web 跑 server agent，对话历史天然不共享。要不要做"agent 历史同步进 vault" 单独立项

## 实施路径建议

按依赖顺序，每步都能跑通、能测：

1. **抽 `packages/shared-types`**——零风险，纯搬运
2. **抽 `packages/vault-adapter` + `LocalProvider`**——把桌面端现有 IPC 调用都换成 provider 调用，行为不变
3. **抽 `packages/agent`**——大头，配独立测试套件，桌面端切到新 agent，回归一遍
4. **写 `apps/server` 最小骨架**——auth + vault CRUD，先不接 agent，用 curl 跑通
5. **写 `apps/web` 最小骨架**——只读浏览 + 登录，跑通端到端
6. **加同步状态 + push/pull**——桌面端先实现 `RemoteProvider`，web 端用同一份
7. **接 server agent**——抽好的 `packages/agent` 接到 WebSocket，web 端打通
8. **打磨 + Docker 化**——`Dockerfile`、`docker-compose.yml`、配置校验、错误提示

每一步都是独立 PR，可以单独 review、单独回滚。
