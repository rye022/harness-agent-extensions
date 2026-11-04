# Harness Agent Extensions

面向 DeepSeek Harness 的独立开源插件集合。仓库包含两个可安装的 Cordis 插件和一个共享库：一个用于记录 agent 文件编辑的文件级时间机器，以及一个在上下文压缩后仍能保留需求和决策的分层上下文存储。插件挂接到 Harness 已有的扩展点，不修改任何 Harness 核心文件。它们可以安装到 profile 中，可以在不启动 Harness 的情况下测试，也可以在移除后不在 Harness 数据库中留下外来数据。

## 解决的问题

Agent 编辑文件很快，却没有持久化的撤销能力。一次失败的改写或误删除通常没有能跨轮次保留的检查点，会话历史里也没有文件此前的字节内容。Time Machine 把文件镜像记录到内容寻址存储中，并提供带冲突检测的恢复路径。

上下文压缩的损失体现在另一方面：对话记录也许还在，但需求、已确认的接口契约或某项决策的理由往往已经消失。Context OS 把这些事实记录为带有层级、作用域和过期时间的条目，并在上下文承压时渲染一份有界简报。

两个插件都从外部解决这些问题。Time Machine 读取会话事件和文件系统；Context OS 读取会话事件并写入自己的 SQLite 数据库。两者都不修改 Harness 核心，不启动第二套压缩循环，也不写入其他插件的数据。

## 包

| 包 | 作用 | 工具 | 服务 |
| --- | --- | --- | --- |
| `@harness-ext/time-machine` | 内容寻址的文件检查点、按轮次自动检查点、差异比较和安全恢复。 | `tm_checkpoint`、`tm_list`、`tm_diff`、`tm_restore`、`tm_status` | `ctx.timeMachine` |
| `@harness-ext/context-os` | 分层记忆（L1/L2/L3）、SQLite FTS5 召回、token 预算决策和有界简报。 | `co_remember`、`co_recall`、`co_brief`、`co_status`、`co_forget` | `ctx.contextOs` |
| `@harness-ext/shared` | 哈希、路径策略、忽略规则、行级差异、JSONL 日志、文件系统辅助函数、token 估算和类型化事件总线。供两个插件使用；本身不是插件。 | 无 | 无 |

两个插件互不依赖。当 `ctx.timeMachine` 存在时，Context OS 可以选择监听 Time Machine 的事件。

## 自动模式

bundle 挂载之后，两个插件的主要工作都不需要模型调用工具：

- **Time Machine** 注册 `fs/write-intent` 和 `fs/edit-intent` 两条瀑布。Agent 的每次写入或编辑都会在真正执行前被捕获，按 SHA-256 去重，并在轮次结束时提交为一个 `auto-turn` 检查点。这个过程不需要模型配合。Shell 命令不在其中：`pwsh` 没有对应的瀑布，所以用脚本改的文件不会留下镜像。
- **Context OS** 订阅 `session/event`。用户消息、目标、失败的工具结果、被改动的文件路径、压缩摘要和会话标题会自动变成记忆记录，作用域分为会话、工作区和全局，并在轮次结束时裁剪。
- **Context OS 也可以自动注入简报。** 当上下文压力越过当前模式的阈值时，`agent/pre-step` 会追加一条简短的 `[Context OS brief]` 用户消息，里面是压缩本来会丢掉的：用户要求、未解决的错误、已确认的决策、正在改的文件。这就是 `inject.enabled`；它默认关闭，因为它会改写模型请求。

要在某个 profile 里启用自动简报，把按 id 定向的配置行加进
`$DSH_HOME/profiles/<名字>/cordis.patch.yml`。这一层在所有 bundle 层之后应用，因此会覆盖 bundle 的默认值：

```yaml
- id: harness-ext-time-machine
  name: "@harness-ext/time-machine"
  config:
    enabled: true
- id: harness-ext-context-os
  name: "@harness-ext/context-os"
  config:
    enabled: true
    mode: balanced # 窗口用到 70% 时触发
    windowTokens: 131072 # 只是兜底；以宿主上报的窗口为准
    inject:
      enabled: true
      minSteps: 3 # 不碰一轮最开始的几步
```

三种模式的差别在“什么时候开始”和“能花多少”：第一个数是触发点，第二个是留给压缩的保留比例，
第三个是简报上限（都是窗口的比例）：

| 模式 | 触发点 | 保留比例 | 简报上限 | 召回条数 |
| --- | --- | --- | --- | --- |
| `conservative` | 85% | 10% | 1.2% | 4 |
| `balanced` | 70% | 20% | 0.9% | 6 |
| `saver` | 50% | 15% | 0.6% | 8 |

保留比例在高压力下并不是照字面扣：`reserve = min(retainTokens, floor(free / 2))`，最多只拿走剩余空间
的一半，另一半留给这一轮本身。简报还至少要有 80 个可用 token。效果是：**只要放得下就会注入**，
90% 压力时也一样；而已经超出窗口的上下文则无空间可给，决策行会写
`no room for a brief: 0 tokens free, 0 reserved, 0 usable (< 80)`。移除 bundle 即可全部停止：

```bash
dsh plugin --profile desktop remove @harness-ext/time-machine @harness-ext/context-os
```

预算以宿主实际上报的窗口为准（`contextPressure.contextWindow`），而不是配置里的 `windowTokens` 默认值——
默认值过期会让所有压力判断都失真。每次决策都会追加到 `$DSH_HOME/context-os/decisions.jsonl`，
所以事后可以回答“为什么没有注入简报”。

## 在真实 Harness 里的验证

两个 bundle 装进 DeepSeek Harness desktop `0.2.1-rc.5` 的 profile，并在真实会话里跑过
（`deepseek-flash`，1 048 576 token 窗口）。下面这些都不是靠调用 `tm_*` / `co_*` 工具触发的。

| 观察到的行为 | 证据 |
| --- | --- |
| 写入在真正发生前就被捕获 | `$DSH_HOME/time-machine/objects/` 有 425 个按内容寻址的文件；探针编辑对应的对象名就是**修改前**字节的 SHA-256，且在工具返回前就已落盘 |
| 轮次结束自动提交检查点 | `checkpoints.jsonl` 里 20 条 `auto-turn` 记录，跨多个会话，0 行损坏 |
| 会话进行中自动入库记忆 | `context.db` 202 条（L1 172 / L2 25 / L3 5）；消息或文件被触碰后 1–2 秒内就能查到对应行 |
| 预算用的是实测窗口 | `decisions.jsonl` 324 行，每行都记录来自 `contextPressure` 的 `windowTokens: 1048576` |
| 模型看得到工具，但不需要调用 | 请求头里共 49 个工具，包含全部五个 `tm_*` 与五个 `co_*` |

想在自己的机器上核对（`$DSH_HOME` 默认是 `~/.dsh`，Windows 上是 `%USERPROFILE%\.dsh`）：

```bash
wc -l "$DSH_HOME/time-machine/checkpoints.jsonl"          # 自动检查点条数
find "$DSH_HOME/time-machine/objects" -type f | wc -l     # 去重后的对象数
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.DSH_HOME+'/context-os/context.db');console.log(db.prepare('select layer,count(*) c from memories group by layer').all())"
tail -n 5 "$DSH_HOME/context-os/decisions.jsonl"           # 为什么注入 / 没注入
```

数量取决于使用情况，数据结构不会变。

## 换一台电脑还能用吗

同一账号登录另一台电脑**不会**把插件带过去。账号只同步模型凭证；profile、bundle 和两个存储都只是 `$DSH_HOME`（`~/.dsh`）下的本地文件。新电脑上默认什么都没有。

两种装法：

1. **用 Release 附件。** 从最新 release 下载三个 tarball 加 `install.ps1` / `install.sh` 到同一个目录，运行安装脚本。它会复制 shared 包到 profile、写入 pnpm 需要的 `overrides:`，然后装上两个 bundle：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop
   ```

   ```bash
   ./install.sh --profile desktop
   ```

2. **从源码。** 克隆仓库，`pnpm install`、`pnpm build`，三个包分别 `pnpm pack`，再按上面的 tarball 步骤安装。

目标机器需要 DeepSeek Harness desktop `0.2.1-rc.5`：bundle patch 只声明与该版本兼容，其它构建可能不接受或忽略这些配置行。

想连历史一起带走，可以复制 `$DSH_HOME/time-machine/`（检查点日志和对象存储）与 `$DSH_HOME/context-os/context.db`。先完全退出 DeepSeek Harness，并把 `context.db-wal`、`context.db-shm` 一起复制，否则最近的写入会留在旧机器上。

## 环境要求

- DeepSeek Harness desktop `0.2.1-rc.5`。bundle patch 只声明与该版本兼容。
- 已安装的插件需要 Node.js `>=22.12.0`。
- 开发需要 pnpm `11.28.5`。根 `package.json` 通过 `packageManager` 固定该版本。
- 开发推荐使用 Node.js 24。测试脚本直接运行 TypeScript 文件，依赖 Node 的类型擦除；没有测试转译器。

仓库只包含 TypeScript 和 Node 内置模块。没有原生构建步骤，也没有打包器。

## 快速开始（开发）

```bash
pnpm install
pnpm test
pnpm build
pnpm typecheck
```

`pnpm test` 通过 `node --test` 运行所有 `packages/*/test/**/*.test.ts` 文件。它直接执行 TypeScript 源码，因此测试套件请使用 Node 24。撰写本文时套件包含 76 个测试，全部通过。`pnpm build` 用 `tsc -b` 为每个包生成 `lib/`；`pnpm typecheck` 以详细输出运行同一套项目构建。使用 `pnpm clean` 删除构建产物。

## 安装到 DeepSeek Harness profile

先把仓库克隆到任意目录，并在该检出目录里操作：

```bash
git clone https://github.com/rye022/harness-agent-extensions.git
cd harness-agent-extensions
pnpm install
pnpm build
```

下面的路径都相对于这个检出目录。desktop profile 由 Electron 应用管理。请用本仓库构建出的 tarball 安装，然后重启应用。示例使用名为 `desktop` 的 profile；请替换成你的 profile 名。

### 1. 构建并打包

先构建：发布入口是 `lib/index.js`，`pnpm pack` 会包含 `lib/`。每条 `pack` 命令都会打印生成的 tarball；默认生成在对应的包目录中。

```bash
pnpm install
pnpm build
pnpm --filter @harness-ext/shared pack
pnpm --filter @harness-ext/time-machine pack
pnpm --filter @harness-ext/context-os pack
```

共享包的 tarball 名为 `harness-ext-shared-0.1.0.tgz`；两个插件包分别是 `harness-ext-time-machine-0.1.1.tgz` 和 `harness-ext-context-os-0.1.1.tgz`。

### 2. 让共享包可以被解析

插件 tarball 依赖 `@harness-ext/shared@0.1.0`。该包尚未发布，pnpm 无法从 registry 获取这个传递依赖。请用 profile 的 `pnpm-workspace.yaml` 中的 `overrides:` 条目把它指向本地 tarball。pnpm 11 从该文件读取 overrides；它会忽略 `package.json` 中的 `pnpm.overrides`。

先把共享包 tarball 复制到 profile 目录：

```bash
cp packages/shared/harness-ext-shared-0.1.0.tgz "$DSH_HOME/profiles/desktop/"
```

未设置时，`$DSH_HOME` 默认为 `~/.dsh`。然后把 override 追加到 `$DSH_HOME/profiles/desktop/pnpm-workspace.yaml`：

```yaml
overrides:
  '@harness-ext/shared': 'file:./harness-ext-shared-0.1.0.tgz'
```

profile 中已经有 `packages:` 列表以及其他 pnpm 设置；请追加 `overrides:` 块，不要替换整个文件。路径相对于 profile 目录。

### 3. 添加插件并重启

```bash
dsh plugin --profile desktop add packages/time-machine/harness-ext-time-machine-0.1.1.tgz
dsh plugin --profile desktop add packages/context-os/harness-ext-context-os-0.1.1.tgz
```

如果 tarball 生成在别处，请传入实际路径。两条命令都执行完后重启 DeepSeek Harness desktop 应用；desktop profile 由 Electron 应用在启动时加载，新 bundle 需要重启后才能挂载。

## 使用

这些工具面向模型。在对话中由 agent 调用；用户也可以要求执行某个具体操作。下面的示例仅作说明：id 和行数经过缩短，实际渲染文本取决于 Harness 的工具渲染器。

### Time Machine：查看、试运行、恢复

在一轮编辑文件的对话之后，agent 可以列出自动检查点：

```text
tm_list { "origin": "auto-turn", "limit": 5 }
```

缩短后的结果：

```text
cp_01j9m2...  auto-turn  2026-...  3 files  turn 12
cp_01j9k8...  auto-turn  2026-...  1 file   turn 11
```

恢复总是先做计划。试运行会报告将要发生的变更，以及当前文件是否仍与检查点一致：

```text
tm_restore { "id": "cp_01j9m2...", "side": "before", "dry_run": true }
```

```json
{
  "dryRun": true,
  "safe": true,
  "writes": 2,
  "deletes": 0,
  "unchanged": 1,
  "unverifiable": 0,
  "conflicts": []
}
```

计划安全时再执行。执行前会为受影响的路径创建 `pre-restore` 检查点，因此这次恢复本身也可以撤销：

```text
tm_restore { "id": "cp_01j9m2...", "side": "before" }
```

```json
{
  "dryRun": false,
  "applied": 2,
  "failed": [],
  "safetyCheckpoint": "cp_01j9n1..."
}
```

如果某个文件在检查点之后发生了变化，计划会报告冲突。除非传入 `force: true`，否则恢复会被拒绝。强制恢复前可以用 `tm_diff` 查看差异，用 `tm_list` 找到正确的检查点或其父检查点。

### Context OS：召回与简报

`co_recall` 搜索当前工作区作用域以及全局记忆。省略 query 时，它按重要性列出记录，而不是执行全文搜索：

```text
co_recall { "query": "retry policy", "scope": "workspace", "limit": 5 }
```

```text
- [L2/decision] Retry policy is capped at three attempts (score 0.91)
  The HTTP client retries only idempotent requests; 429 and 503 are retried...
- [L2/contract] HttpClient.send must keep its AbortSignal parameter (score 0.84)
  ...
```

`co_brief` 渲染应当在压缩后保留的记忆，并裁剪到指定的 token 预算。它在压缩之后或对话出现信息损失时很有用：

```text
co_brief { "query": "HTTP client refactor", "max_tokens": 900 }
```

文本按 [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) 中描述的顺序分段：请求、未解决的错误、进行中的文件、决策与契约、进度与待办，最后是可选的长期召回。`query` 参数是可选的。在 V0.1 中它只用于长期召回段，不会从最近一条用户消息中推断。

### 一段简短的会话流程

1. 用户要求重构，并给出约束：保留公开的 `HttpClient.send` 签名。
2. agent 用 `co_remember` 记录约束，然后编辑两个文件。Time Machine 捕获修改前的镜像，并在轮次结束时生成一个 `auto-turn` 检查点。
3. 一次压缩删除了早先的讨论。agent 调用 `co_brief` 和 `co_recall`，找回约束和未解决的错误。
4. 后续编辑导致测试失败。agent 调用 `tm_list`，再以 `dry_run: true` 调用 `tm_restore`，确认计划安全后执行。如果这次撤销是错误的，`pre-restore` 检查点仍然可用。

## 安全模型

- **内容寻址存储。** 文件镜像以 SHA-256 对象存放在 `$DSH_HOME/time-machine/objects/` 下；相同内容只存一份。检查点保存的是哈希，不是整棵目录树的副本。
- **忽略策略。** 内置规则跳过 VCS 目录、`node_modules`、缓存目录、常见密钥文件（`.env`、`*.pem`、`*.key`、SSH 密钥、credentials）以及符号链接。超过 `maxFileBytes`（默认 2 MiB）的文件只记录为 oversized 元数据，不保存内容，因此无法恢复。
- **先计划后写入。** `tm_restore` 在不触碰文件系统的情况下计算计划。它把每个路径分类为 write、delete、unchanged、unverifiable 或冲突，并在计划存在冲突时拒绝执行，除非设置 `force: true`。
- **恢复前检查点。** 在执行任何写入或删除之前，Time Machine 会把受影响的路径快照到 `pre-restore` 检查点。
- **重新哈希校验。** 恢复写入的每个文件都会再次计算哈希。存在未通过校验的写入时，恢复会被报告为失败，而不是完成。
- **作用域。** 快照扫描工作区根目录。恢复只写入检查点及其计划中列出的路径；不会后台扫描或修改其他目录、profile 数据或 Harness 会话存储。
- **仅本地。** 两个插件都不发起网络请求。Context OS 使用 SQLite FTS5；没有 embedding、没有向量索引，也没有外部模型调用。
- **不修改核心。** 插件不修改 Harness 核心文件，不追加 Harness 会话日志，也不写入其他插件的存储。

## 限制

- **通过 shell 间接完成的编辑无法从事件中重建。** `pwsh` 的结果只带工作目录，`str_replace_editor` 不产生文件元数据。Time Machine 的事件捕获覆盖 `write` 和 `edit` 意图。可选的 `capture.workspaceSnapshotOnTurnStart` 会增加一个粗略的轮次开始快照，可以恢复整个工作区，但它每轮都要做一次全量扫描，默认关闭。
- **V0.1 没有客户端 GUI。** 对外提供的是五个 `tm_*` 工具、五个 `co_*` 工具、两个 Cordis 服务和事件总线。只读客户端面板已列入计划，尚未实现。
- **恢复文件不等于恢复模型上下文。** Time Machine 能把文件字节放回去，但无法回退对话、会话日志或模型上下文。恢复后 Context OS 可以把相关记忆标记为 stale，但它不会重建会话或重放某一轮。
- **对 Harness 和其他插件只读。** 两个插件都不编辑 Harness 核心代码、会话日志、profile 文件或其他插件的数据库。文件恢复当然可能改变其他工具也会使用的文件；这正是恢复的预期效果。
- **没有会话级恢复。** 检查点以文件为单位。目前不支持恢复整个会话或对话记录。
- **平台边界。** 符号链接和 Windows junction 不会被捕获。UNC 路径以及 Windows junction/reparse point 的边界情况没有测试覆盖。
- **仅合成基准。** 基准语料是生成的，不是生产 trace，数字也取决于机器。

## 测试与基准

在仓库根目录运行测试套件：

```bash
pnpm test
```

运行器是 `node --test`。当前套件共有 76 个测试：

| 区域 | 文件 | 测试数 | 覆盖内容 |
| --- | --- | --- | --- |
| 共享基础函数 | `packages/shared/test/diff.test.ts` | 10 | 行级差异、hunk、边界情况 |
| Time Machine 核心 | `packages/time-machine/test/core.test.ts` | 9 | 对象存储、垃圾回收、轮次捕获、首次写入优先、忽略策略、恢复计划、删除恢复、损坏日志、并发修改守卫 |
| Time Machine 插件 | `packages/time-machine/test/plugin.test.ts` | 4 | 挂载、轮次结束时捕获、`tm_restore`、冲突拒绝、`ctx.effect` 清理，使用模拟 Cordis 上下文 |
| Time Machine Cordis | `packages/time-machine/test/cordis.test.ts` | 4 | 在真实 Cordis 4.0.5 下挂载、`fs/write-intent` 捕获、工具往返、清理 |
| Context OS 存储 | `packages/context-os/test/store.test.ts` | 11 | remember/stats、去重、中文 FTS 召回、作用域隔离、过期、stale 标记、forget、prune、非法 MATCH 回退、v0 迁移、新版本拒绝 |
| Context OS 核心 | `packages/context-os/test/core.test.ts` | 11 | 预算 profile、阈值、预留空间按剩余空间一半封顶、80 token 拒绝、覆盖值、优先使用当前请求、分段顺序、截断、ingest 映射、忽略事件 |
| Context OS 插件 | `packages/context-os/test/plugin.test.ts` | 8 | 服务与工具、L1 捕获、L2 目标、未解决错误、remember/recall 往返、简报上限、清理、错误配置 |
| 压缩保留 | `packages/context-os/test/compaction.test.ts` | 2 | 摘要替换后请求、目标、错误、文件仍在简报里；召回仍能命中原始请求 |
| 双插件协同 | `tests/interop.test.ts` | 3 | 同一 Cordis 上下文挂载两个包、工具名不冲突、检查点镜像为记忆、可独立卸载 |
| 打包 | `tests/packaging.test.ts` | 10 | 清单字段、`dsh.bundle.patch` 形状、兼容性标注、peer 范围、构建产物导出 |
| 工具管线 | `tests/tool-runtime.test.ts` | 1 | 用 `@deepseek-ai/dsh-tools` 的真实 `ToolRuntime` 执行全部工具：文本块、JSON 往返、不产生错误结果 |

执行 `pnpm build` 后生成的 `lib/` 是 `pnpm pack` 打包、profile 加载的内容；测试始终直接运行 TypeScript 源码，因此不需要先构建。根 `tsconfig.base.json` 使用项目引用，构建顺序由 `tsc -b` 处理。

### 基准

```bash
pnpm bench
```

`pnpm bench` 运行 `node benchmarks/run-all.ts`。它执行三个合成基准，并写出 `benchmarks/results/latest.json` 和 `latest.md`：

- `bench-checkpoint.ts` 构建一个包含 800 个文件、每个文件约 3 KiB 的工作区，测量工作区扫描、全量快照、五轮每轮 20 个文件的编辑、恢复计划（包括冲突计划）、带校验的强制恢复、120k 字符改写的差异，以及最终的对象存储和日志占用。
- `bench-recall.ts` 写入 1200 条填充记录和 40 个唯一 token 目标（拉丁字母和中文），测量写入耗时、hit@1、hit@5、平均倒数排名、召回延迟 p50/p95，以及跨工作区作用域泄漏。它会断言最低命中率和零泄漏计数。
- `bench-brief.ts` 写入 8 条关键记录和 600 条填充记录，测量 300、900 和 3000 token 预算下的关键记录覆盖率、简报构建延迟 p50/p95，以及无预算上限的构建。它还会打印每种 mode 在 25%、50%、70% 和 92% 压力下的预算决策。

传入套件名可以只运行该套件：

```bash
node benchmarks/run-all.ts brief
```

基准断言失败时，运行器以非零状态退出。结果取决于机器，不构成兼容性承诺。`benchmarks/probe-sqlite.cjs` 是用于检查 Node、SQLite、FTS5 和 tokenizer 可用性的环境探针，不属于 `pnpm bench`。

### 大型仓库基准

```bash
pnpm bench:scale
```

`pnpm bench:scale` 是可选的大型仓库测量（NVMe 笔记本上约一分钟）。它在一个临时工作区写入 10 000 个文件（11.9 MiB），测量两条会遍历全部文件的路径：

| 步骤 | 实测（Node 24、NVMe、Windows） | 伸缩性 |
| --- | --- | --- |
| 工作区扫描 | 10 000 个文件 1 069 ms | 0.107 ms/文件，线性 |
| 完整快照（默认 `maxFiles` 5 000） | 12 851 ms，0.92 MiB/s | 随字节数线性 |
| 轮次捕获，20 个文件 | 中位数 26 ms | 与实际触及的文件数成正比，与仓库大小无关 |
| 5 000 条目的恢复计划 | 1 885 ms（50 写入，4 950 未变） | 每条目一次哈希 |
| 恢复执行，50 个文件 | 499 ms，已校验 | 每文件 |

把它指向 monorepo 之前需要知道的两点：

- 轮次捕获是廉价模式，也是默认模式：无论仓库多大，每轮约 26 ms，因为只哈希该轮触及的文件。
- 完整快照受大小约束（`maxFiles` 默认 5 000，`maxFileBytes` 默认 2 MiB，两者都可配置）。在 10 000 文件的仓库上默认快照只覆盖一半目录树；请有意识地调大 `maxFiles`，并预期约 1 MiB/s。
- 恢复计划会对每个条目重新哈希，因此计划成本随检查点规模增长，而不是随漂移文件数量增长。面对 10 万文件的目录树时，请恢复 `before`/`after` 中较小的一侧，或用 `onlyPaths` 缩小检查点。

可用 `BENCH_SCALE_FILES` 改变文件数，例如 `BENCH_SCALE_FILES=2000 node benchmarks/bench-scale.ts`。该运行不做任何断言：绝对数字更多取决于磁盘而非代码。

## 仓库结构

```text
harness-agent-extensions/
├── packages/
│   ├── shared/                 # hashing, ignore policy, diff, JSONL, fs, tokens, bus
│   ├── time-machine/           # plugin, tools, checkpoint store, restore, scan
│   └── context-os/             # plugin, tools, SQLite store, budget, brief, ingest
├── benchmarks/                 # synthetic checkpoint, recall, and brief benchmarks
├── docs/
│   ├── CONFIGURATION.md        # every configuration key for both plugins
│   └── research/               # design notes and upstream API research (00-06)
├── ARCHITECTURE.md             # design rationale, limitations, verification matrix
├── CHANGELOG.md                # release notes
├── CONTRIBUTING.md             # development and review workflow
├── README.md                   # this file
├── README.zh-CN.md             # Chinese translation of this file
├── LICENSE                     # MIT
├── package.json                # pnpm workspace root and scripts
├── install.ps1                 # Windows profile 安装脚本
├── install.sh                  # macOS/Linux profile 安装脚本
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：设计理由、扩展点、数据模型、安全规则、限制以及验证矩阵。
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md)：所有配置键、预算模式、归一化规则和数据位置。
- [CHANGELOG.md](CHANGELOG.md)：每个版本的改动与 release 附件链接。
- [CONTRIBUTING.md](CONTRIBUTING.md)：环境搭建、约定、添加工具或测试，以及评审清单。
- [README.zh-CN.md](README.zh-CN.md)：本 README 的中文翻译。
- 设计笔记：[00-architecture-review.md](docs/research/00-architecture-review.md)、
  [01-cordis-core.md](docs/research/01-cordis-core.md)、
  [02-session-events.md](docs/research/02-session-events.md)、
  [03-checkpoints-storage.md](docs/research/03-checkpoints-storage.md)、
  [04-context-compaction.md](docs/research/04-context-compaction.md)、
  [05-tools-permissions-config.md](docs/research/05-tools-permissions-config.md)、
  [06-ui-client.md](docs/research/06-ui-client.md)。

## 状态与许可

V0.1.2。这些包尚未发布到 npm；请按上面的说明从 tarball 或 release 附件安装。宿主 API 已在日常会话中可用，
客户端面板仍在计划中。各版本改动见 [CHANGELOG.md](CHANGELOG.md)。

MIT。见 [LICENSE](LICENSE)。欢迎贡献；请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
