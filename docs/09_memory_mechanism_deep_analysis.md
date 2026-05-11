# Claude Code 源码深度解析（九）：Memory 机制全链路源码级分析

> **系列索引** | 本篇为第九篇：基于源码逐行阅读的 Memory 机制完整剖析。与第三篇（架构概述）和第五篇（KAIROS/AutoDream）互补，本篇聚焦于**源码级的实现细节、工程决策和可迁移的设计模式**。

---

## 一、架构总览：三个时间尺度的记忆子系统

Claude Code 的 Memory 系统由三个**时间尺度不同**的子系统协同运作。这不是偶然——它模仿了人类记忆的"工作记忆→短期记忆→长期记忆"三层模型。

| 层 | 模块 | 时间尺度 | 触发方式 | 每 turn 成本 |
|---|---|---|---|---|
| **即时回忆** | `memdir/findRelevantMemories.ts` | 每次用户查询 | System prompt 注入 + Sonnet 筛选 | 一次 Sonnet side query |
| **逐轮提取** | `services/extractMemories/` | 每个 turn 结束 | `stopHooks.ts` → forked agent | 共享 prompt cache 的 fork |
| **周期整合** | `services/autoDream/` | ~24h + 5 sessions | `stopHooks.ts` → forked agent | 仅一次 stat（门控未通过时） |

**关键数据流**：

```
SESSION START
  │
  ├─ backgroundHousekeeping.ts → initExtractMemories() + initAutoDream()
  │
USER QUERY
  │
  ├─ systemPromptSection('memory') → loadMemoryPrompt()
  │    ├─ MEMORY.md 内容注入 system prompt（缓存）
  │    └─ findRelevantMemories() → Sonnet 筛选最多 5 条记忆
  │
  ├─ 模型处理 + 响应
  │
  └─ stopHooks.ts（turn 结束）
       ├─ executeExtractMemories()  [如果 EXTRACT_MEMORIES 启用]
       │    ├─ 检查主 agent 是否已写记忆 → 是则跳过
       │    └─ fork 子 agent → 提取 + 写入
       └─ executeAutoDream()        [如果 autoDream 启用]
            ├─ 时间门 → 扫描节流 → session 门 → 锁
            └─ fork 子 agent → 四阶段整合
```

---

## 二、存储层：文件系统即数据库

### 2.1 目录结构

```
~/.claude/projects/<sanitized-git-root>/memory/
├── MEMORY.md              ← 索引文件（始终注入 system prompt）
├── user_role.md            ← 类型化记忆文件
├── feedback_testing.md
├── project_deadline.md
├── reference_linear.md
├── .consolidate-lock       ← autoDream 锁（mtime = 上次整合时间戳）
└── team/                   ← 团队共享记忆（TEAMMEM feature flag）
    ├── MEMORY.md
    └── ...
```

**路径解析优先级**（`memdir/paths.ts:223-235`）：

```
1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 环境变量（SDK 完整路径覆盖）
2. settings.json 中的 autoMemoryDirectory（仅信任 policy/local/user 源）
3. 默认: <memoryBase>/projects/<sanitized-git-root>/memory/
```

其中 `<memoryBase>` 先检查 `CLAUDE_CODE_REMOTE_MEMORY_DIR`，回退到 `~/.claude`。

### 2.2 索引文件的双重截断保护

`MEMORY.md` 有两个独立的上限，这是源于真实线上问题的防御性设计：

```typescript
// memdir/memdir.ts:35-38
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000  // ~125 chars/line × 200 lines
```

为什么需要字节上限？代码注释说明（`memdir/memdir.ts:36-37`）：

> At p97 today; catches long-line indexes that slip past the line cap (p100 observed: 197KB under 200 lines).

即：有用户的 `MEMORY.md` 虽然行数 <200，但单行极长，导致文件达到 197KB。

截断逻辑（`memdir/memdir.ts:57-103`）：
1. 先按行截断（自然边界）
2. 再按字节截断（在 `lastIndexOf('\n')` 处切，不切断行中间）
3. 附加警告信息，明确告知是哪个上限触发的

```typescript
const reason =
  wasByteTruncated && !wasLineTruncated
    ? `${formatFileSize(byteCount)} (limit: ...) — index entries are too long`
    : wasLineTruncated && !wasByteTruncated
      ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
      : `${lineCount} lines and ${formatFileSize(byteCount)}`
```

### 2.3 安全验证：路径校验

`validateMemoryPath()`（`paths.ts:109-150`）是记忆系统的安全边界：

**拒绝的路径类型**：
- 相对路径（`!isAbsolute`）
- 根目录或近根目录（`length < 3`）
- Windows 驱动器根（`/^[A-Za-z]:$/`）
- UNC 路径（`\\server\share`）
- 包含 null byte（能在 syscall 中截断）

**最精妙的安全设计**（`paths.ts:170-186`）：`projectSettings`（仓库内 `.claude/settings.json`）被**故意排除在可信来源之外**：

```typescript
// SECURITY: projectSettings (.claude/settings.json committed to the repo) is
// intentionally excluded — a malicious repo could otherwise set
// autoMemoryDirectory: "~/.ssh" and gain silent write access to sensitive
// directories via the filesystem.ts write carve-out
```

即：恶意仓库可以在提交的配置文件中设置 `autoMemoryDirectory: "~/.ssh"`，借助文件系统写入豁免获取敏感目录的写权限。排除 `projectSettings` 后，只有用户自己的配置（`localSettings`/`userSettings`）和管理员策略（`policySettings`）能覆盖路径。

### 2.4 Git worktree 共享

```typescript
// paths.ts:203-205
function getAutoMemBase(): string {
  return findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()
}
```

`findCanonicalGitRoot()` 确保同一仓库的所有 worktree 共享同一个记忆目录。引用自 issue #24382。

---

## 三、记忆类型分类学：封闭四类型

### 3.1 四种类型及其设计意图

`memdir/memoryTypes.ts:14-19` 定义了一个**封闭分类法**：

```typescript
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
```

| 类型 | 存什么 | 示例 |
|---|---|---|
| `user` | 用户角色、偏好、知识水平 | "深度 Go 经验，React 新手——用后端类比解释前端" |
| `feedback` | 用户纠正 + 确认的行为准则 | "集成测试必须用真数据库，不要 mock" |
| `project` | 不可从代码/git 推导的项目上下文 | "合并冻结从 2026-03-05 开始" |
| `reference` | 外部系统指针 | "pipeline bugs 追踪在 Linear 的 INGEST 项目" |

### 3.2 不该存什么——负面清单

`memoryTypes.ts:183-195` 定义了明确的排除规则：

```
- 代码模式、架构、文件路径、项目结构 → 读代码就能得到
- Git 历史、谁改了什么 → git log / git blame
- 调试方案 → fix 在代码里，上下文在 commit message 里
- CLAUDE.md 里已有的内容 → 避免重复
- 临时任务详情、进行中的工作 → 用 tasks 而非 memory
```

**关键设计决策**（`memoryTypes.ts:192-195`）：

> These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.

即使用户说"帮我记住这个 PR 列表"，agent 也应该反问"其中什么是意外的或不明显的？"。这经过了 eval 验证（memory-prompt-iteration case 3, 0/2 → 3/3）。

### 3.3 feedback 记忆：记录成功和失败

`memoryTypes.ts:134` 的设计意图：

> Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious.

如果只存纠正不存确认，agent 会越来越保守——它学会了"不要做 X"但忘了"做 Y 是对的"。这是一个关于**正反馈偏差**的深刻洞察。

### 3.4 记忆体结构

feedback 和 project 类型要求三段式结构：

```markdown
规则/事实本身

**Why:** 原因（通常是过去的事故或强烈偏好）
**How to apply:** 何时/何处应用这条规则
```

附带 Why 的目的是让 agent 能判断**边界情况**，而不是盲目遵循规则。

---

## 四、写入路径一：主 Agent 直接写入

主 agent 的 system prompt 包含完整的记忆保存指令（通过 `loadMemoryPrompt()` → `buildMemoryLines()` 注入）。保存是两步操作：

1. 写记忆文件（带 frontmatter：name, description, type）
2. 在 `MEMORY.md` 添加一行指针（`- [Title](file.md) — one-line hook`）

`buildMemoryLines()`（`memdir.ts:199-266`）构建的指令包含：
- 类型分类学
- 不该存什么
- 如何保存（两步流程）
- 何时访问记忆
- 推荐前的验证要求
- 与 plan/task 的区分

当 `skipIndex` 参数为 true 时（由 `tengu_moth_copse` feature flag 控制），省略第二步索引更新——这表明 Anthropic 正在实验是否需要 `MEMORY.md` 索引。

---

## 五、写入路径二：后台提取 Agent（extractMemories）

### 5.1 核心机制

`services/extractMemories/extractMemories.ts`（615 行）实现了一个**与主 agent 互斥的后台记忆提取器**。

**触发流程**：
1. 每个 turn 结束时，`stopHooks.ts` 调用 `executeExtractMemories()`
2. 检查 `tengu_passport_quail` feature flag（GrowthBook 门控）
3. 检查 `isAutoMemoryEnabled()`
4. 排除远程模式和子 agent
5. 排除并行重叠（`inProgress` 标志）

### 5.2 互斥写入——最关键的设计

```typescript
// extractMemories.ts:121-148
function hasMemoryWritesSince(messages, sinceUuid): boolean {
  // 扫描 sinceUuid 之后的所有 assistant 消息
  // 如果发现任何 Edit/Write 的 tool_use 目标在 auto-memory 路径内
  // → 返回 true → 跳过提取
}
```

这实现了**两条写入路径的互斥**：主 agent 写了就不再后台提取，后台提取只在主 agent"没注意到"的时候运行。游标（`lastMemoryMessageUuid`）确保每段消息只被处理一次。

**游标丢失的降级**（`extractMemories.ts:104-109`）：context compaction 可能删除游标指向的消息。此时回退到计数所有可见消息而非返回 0——避免永久禁用提取。

### 5.3 Forked Agent 模式

提取 agent 使用 `runForkedAgent()`——一个**完美克隆**：

```typescript
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: userPrompt })],
  cacheSafeParams: createCacheSafeParams(context),  // 共享 prompt cache
  canUseTool: createAutoMemCanUseTool(memoryRoot),   // 受限工具集
  querySource: 'extract_memories',
  skipTranscript: true,   // 不写入主 transcript
  maxTurns: 5,            // 防止兔子洞
})
```

**prompt cache 共享**是核心成本优化：fork agent 继承父对话的 cache prefix，避免重复计费长 system prompt。

### 5.4 工具权限约束

`createAutoMemCanUseTool()`（`extractMemories.ts:171-222`）定义了提取 agent 的沙箱：

| 工具 | 权限 |
|---|---|
| FileRead / Grep / Glob | 无限制 |
| Bash | 仅只读命令（ls/find/grep/cat/stat/wc/head/tail） |
| FileEdit / FileWrite | 仅 memory 目录内 |
| REPL | 允许（因为 ant 构建中原始工具被隐藏，REPL 内部会再次调用 canUseTool） |
| 其他所有工具 | 拒绝 |

### 5.5 高效提取策略

提取 prompt（`services/extractMemories/prompts.ts:29-43`）要求 agent 使用两轮策略：

> Turn 1 — issue all FileRead calls in parallel for every file you might update  
> Turn 2 — issue all FileWrite/FileEdit calls in parallel

这最大化了并行度，配合 `maxTurns: 5` 的硬上限。

### 5.6 防重叠与 Trailing Extraction

```typescript
// 闭包作用域的状态
let inProgress = false
let pendingContext: { context, appendSystemMessage } | undefined

// 当提取正在运行时，新请求被 stash
if (inProgress) {
  pendingContext = { context, appendSystemMessage }
  return
}

// 运行完成后检查是否有 stash 的请求
finally {
  inProgress = false
  const trailing = pendingContext
  pendingContext = undefined
  if (trailing) {
    await runExtraction({ ...trailing, isTrailingRun: true })
  }
}
```

这避免了并行运行的竞态，同时确保不丢失任何待处理的 turn。

---

## 六、写入路径三：周期整合 Agent（autoDream）

### 6.1 门控链——从便宜到贵

`services/autoDream/autoDream.ts` 的门控设计是**成本敏感工程**的范本：

```
Step 0: isGateOpen()
  ├─ KAIROS 模式？→ 跳过（KAIROS 有自己的 dream skill）
  ├─ 远程模式？→ 跳过
  ├─ autoMemory 未启用？→ 跳过
  └─ autoDream 未启用？→ 跳过
  成本：0（内存中的布尔检查）

Step 1: readLastConsolidatedAt()
  └─ stat(.consolidate-lock) → mtimeMs
  成本：一次 stat 调用（几 μs）

Step 2: hoursSince >= minHours (默认 24)?
  └─ 不满足 → return
  成本：一次算术运算

Step 3: 扫描节流
  └─ 上次扫描 <10 分钟前？→ return
  成本：一次时间比较

Step 4: listSessionsTouchedSince()
  └─ 遍历 session 目录，过滤 mtime > lastConsolidatedAt
  └─ 排除当前 session
  └─ count >= minSessions (默认 5)?
  成本：ms 级目录遍历

Step 5: tryAcquireConsolidationLock()
  └─ 文件锁（见下节）
  成本：stat + read + write + read（验证）
```

**设计原则**：每个 turn 都会执行到 Step 2。只有 24h+ 才执行 Step 3-5。日常运行时每 turn 成本仅为"一次 GB cache 读 + 一次 stat"。

### 6.2 锁机制——一个文件承载三个功能

`.consolidate-lock`（`services/autoDream/consolidationLock.ts`）：

| 属性 | 含义 |
|---|---|
| 存在性 | 是否曾经执行过整合 |
| mtime | 上次成功整合的时间戳（`lastConsolidatedAt`） |
| 文件内容 | 当前持有者的 PID |

**获取锁的流程**（`consolidationLock.ts:46-83`）：

```
1. stat + readFile（并行）→ 获取 mtime 和 holder PID
2. 如果 mtime < 60 分钟 AND PID 仍在运行 → 被占用，返回 null
3. 如果 PID 死了或超时 → 抢占
4. writeFile(lockPath, myPID)
5. readFile(lockPath) → 验证写入的是自己的 PID
6. 如果不是（另一个 reclaimer 后写）→ 返回 null
7. 返回 priorMtime（用于失败回滚）
```

**失败回滚**（`consolidationLock.ts:91-108`）：

```typescript
export async function rollbackConsolidationLock(priorMtime: number) {
  if (priorMtime === 0) {
    await unlink(path)       // 恢复到"无文件"状态
    return
  }
  await writeFile(path, '')   // 清空 PID（防止自己看起来仍在持有）
  const t = priorMtime / 1000
  await utimes(path, t, t)    // 回退 mtime
}
```

这让时间门重新开放，下次触发可以再次尝试。

### 6.3 四阶段整合 Prompt

`services/autoDream/consolidationPrompt.ts` 构建的 dream prompt 分四个阶段：

**Phase 1 — Orient（定位）**：
- `ls` 记忆目录
- 读 `MEMORY.md` 了解当前索引
- 浏览现有主题文件避免创建重复

**Phase 2 — Gather Signal（收集信号）**：
- 按优先级：日志 > 已漂移的记忆 > transcript 搜索
- 对 transcript 只用窄范围 grep，不全量读取

**Phase 3 — Consolidate（整合）**：
- 合并到现有主题文件（不创建近似重复）
- 转换相对日期为绝对日期
- 删除被新信息推翻的旧事实

**Phase 4 — Prune & Index（修剪与索引）**：
- 保持 `MEMORY.md` <200 行 <25KB
- 每条一行 <150 字符
- 删除过时指针
- 压缩冗长条目

### 6.4 Dream Task 状态管理

整合过程在 UI 中可见（`tasks/DreamTask/DreamTask.ts`）：

```typescript
const taskId = registerDreamTask(setAppState, {
  sessionsReviewing: sessionIds.length,
  priorMtime,
  abortController,  // 用户可以从 bg-tasks 对话框中止
})
```

- 用户可见的进度指示
- 可通过 AbortController 中止
- 中止时自动回滚锁的 mtime

---

## 七、读取层：查询时的相关性筛选

### 7.1 MEMORY.md 常驻加载

`MEMORY.md` 通过 `systemPromptSection('memory', ...)` 注入 system prompt。`systemPromptSection` 有缓存——同一 session 内只构建一次。

### 7.2 Sonnet 筛选机制

`memdir/findRelevantMemories.ts` 实现了基于 LLM 的记忆相关性筛选：

```
所有 .md 文件 → scanMemoryFiles()
  ├─ readdir(memoryDir, { recursive: true })
  ├─ 过滤 .md 文件，排除 MEMORY.md
  ├─ 并行读取前 30 行提取 frontmatter
  └─ 按 mtime 倒序排列，取前 200 个

格式化为 manifest → formatMemoryManifest()
  └─ 每行: "- [type] filename (ISO时间戳): description"

用户查询 + manifest → Sonnet (max_tokens=256, json_schema 输出)
  └─ 返回 { selected_memories: string[] }（最多 5 个文件名）

验证 → 过滤不存在的文件名 → 返回 { path, mtimeMs }[]
```

**关键细节**：
- `recentTools` 参数：如果 agent 正在使用某工具，不选该工具的参考文档（避免噪音），但**仍然选 warnings/gotchas 类记忆**——正在使用时才是这些警告最相关的时候
- `alreadySurfaced` 过滤：已展示的记忆不再重复选，5 个名额留给新候选
- 即使选择为空也触发 telemetry（需要分母来计算选择率）

### 7.3 防过时机制——三道防线

**第一道：存储时排除可推导信息**

代码模式、架构、git 历史不存为记忆，从根源减少过时可能。

**第二道：回忆时附加过期警告**

`memdir/memoryAge.ts:33-42`：

```typescript
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}
```

超过 1 天的记忆会被注入这段警告。

**第三道：推荐前要求验证**

`memoryTypes.ts:240-256`（经 eval 验证，标题措辞 A/B 测试 3/3 vs 0/3）：

```
- 记忆提到文件路径 → 先检查文件存在
- 记忆提到函数名或 flag → 先 grep
- 用户要基于推荐行动 → 先验证

"记忆说 X 存在" ≠ "X 现在存在"
```

---

## 八、KAIROS 模式下的变体：append-only 日志

当 `feature('KAIROS')` 启用且 `getKairosActive()` 为 true 时，记忆系统切换到**日志模式**（`memdir.ts:327-370`）：

```
~/.claude/projects/.../memory/
└── logs/
    └── 2026/
        └── 03/
            └── 2026-03-31.md   ← 今天的日志
```

与标准模式的区别：
- 不维护 `MEMORY.md` 索引（由独立的夜间 `/dream` skill 整合）
- 记忆以带时间戳的 bullet 追加到日志文件
- `MEMORY.md` 仍被加载（作为整合后的索引），但新记忆不写入

**Prompt 缓存考量**（`memdir.ts:330-334`）：

```typescript
// Describe the path as a pattern rather than inlining today's literal path:
// this prompt is cached by systemPromptSection('memory', ...) and NOT
// invalidated on date change.
const logPathPattern = join(memoryDir, 'logs', 'YYYY', 'MM', 'YYYY-MM-DD.md')
```

如果写入当天的实际日期，system prompt 会在午夜时变化导致 cache 失效。使用模式字符串让 prompt 跨日期保持稳定。

---

## 九、Feature Flag 全景

| Flag | 类型 | 控制什么 |
|---|---|---|
| `EXTRACT_MEMORIES` | 编译时 | 逐轮后台记忆提取 |
| `KAIROS` | 编译时 | 日志模式 + 守护进程 |
| `TEAMMEM` | 编译时 | 团队共享记忆（private + team 双目录） |
| `MEMORY_SHAPE_TELEMETRY` | 编译时 | 记忆回忆形状分析 |
| `tengu_passport_quail` | 运行时 GrowthBook | extractMemories 总开关 |
| `tengu_onyx_plover` | 运行时 GrowthBook | autoDream 阈值（minHours, minSessions） |
| `tengu_coral_fern` | 运行时 GrowthBook | "Searching past context" 章节显示 |
| `tengu_moth_copse` | 运行时 GrowthBook | 跳过 MEMORY.md 索引步骤 |
| `tengu_bramble_lintel` | 运行时 GrowthBook | 每 N 个 turn 才提取一次（默认 1） |
| `tengu_herring_clock` | 运行时 GrowthBook | 团队记忆 cohort 标记 |
| `tengu_slate_thimble` | 运行时 GrowthBook | 非交互 session 也提取 |

**启用/禁用逻辑**（`paths.ts:30-55`）：

```
禁用条件（按优先级）：
1. CLAUDE_CODE_DISABLE_AUTO_MEMORY=1/true → 禁用
2. CLAUDE_CODE_DISABLE_AUTO_MEMORY=0/false → 强制启用
3. CLAUDE_CODE_SIMPLE (--bare) → 禁用
4. CLAUDE_CODE_REMOTE 且无 REMOTE_MEMORY_DIR → 禁用
5. settings.json autoMemoryEnabled === false → 禁用
6. 默认 → 启用
```

---

## 十、关键源码文件速查表

| 文件 | 行数 | 核心职责 | 关键导出 |
|---|---|---|---|
| `memdir/memdir.ts` | 508 | 系统 prompt 构建 + 记忆指令 | `loadMemoryPrompt()`, `buildMemoryLines()`, `truncateEntrypointContent()` |
| `memdir/paths.ts` | 279 | 路径解析 + 安全校验 | `getAutoMemPath()`, `isAutoMemPath()`, `isAutoMemoryEnabled()` |
| `memdir/memoryTypes.ts` | 272 | 四类型分类法 + 保存/访问规则 | `MEMORY_TYPES`, `TYPES_SECTION_*`, `TRUSTING_RECALL_SECTION` |
| `memdir/memoryScan.ts` | 95 | 记忆文件发现 + frontmatter 解析 | `scanMemoryFiles()`, `formatMemoryManifest()` |
| `memdir/findRelevantMemories.ts` | 142 | 查询时相关性筛选 | `findRelevantMemories()` |
| `memdir/memoryAge.ts` | 54 | 过期计算 + 新鲜度警告 | `memoryAge()`, `memoryFreshnessText()` |
| `services/autoDream/autoDream.ts` | 325 | 后台整合守护 | `initAutoDream()`, `executeAutoDream()` |
| `services/autoDream/consolidationPrompt.ts` | 66 | 四阶段 dream prompt | `buildConsolidationPrompt()` |
| `services/autoDream/consolidationLock.ts` | 141 | 文件锁（mtime = 时间戳） | `tryAcquireConsolidationLock()`, `rollbackConsolidationLock()` |
| `services/extractMemories/extractMemories.ts` | 615 | 逐轮后台提取 | `initExtractMemories()`, `executeExtractMemories()`, `createAutoMemCanUseTool()` |
| `services/extractMemories/prompts.ts` | 155 | 提取 agent prompt | `buildExtractAutoOnlyPrompt()`, `buildExtractCombinedPrompt()` |

---

## 十一、可迁移的设计模式

### 11.1 三层时间尺度分离

任何需要持久化的 AI agent 系统都可以借鉴"热/温/冷"分层：
- **热层**（每次查询）：轻量筛选，低延迟
- **温层**（每 turn/每次交互）：共享缓存的后台 agent
- **冷层**（天级/周级）：完整的整合 + 修剪

### 11.2 互斥写入 + 游标推进

多个 writer 竞争同一数据源时，"检测已写→跳过→推进游标"比"加锁等待"更适合 AI agent 场景。agent 的每次运行是独立的，不需要数据库级的事务保证。

### 11.3 文件系统作为接口

不用 SQLite，不用向量库，用 markdown + frontmatter + 文件系统 mtime：
- 用户可直接编辑
- git 友好（团队记忆可 commit）
- `ls` / `grep` 就能调试
- 零依赖

### 11.4 封闭分类法 + 负面清单

"存什么"用封闭类型约束，"不存什么"用明确排除规则。比开放式的"存任何有用的东西"有效得多——记忆越多，筛选越难，真正有用的被淹没。

### 11.5 Eval 驱动的 Prompt 迭代

源码注释记录了每个章节的 eval 验证结果：
- `H1 (verify function/file claims): 0/2 → 3/3 via appendSystemPrompt`
- 章节标题 "Before recommending"（行动导向） vs "Trusting what you recall"（抽象）：3/3 vs 0/3

同样的正文，只换标题就有天壤之别。System prompt 优化必须有可量化的 eval 支撑。

### 11.6 成本门控链

后台 agent 在每个 turn 都运行，必须极其节俭。从 0-cost 的布尔检查到 ms 级的目录扫描，**严格按成本升序排列**。任何一步不通过立即退出。日常每 turn 成本：一次 stat 调用。

### 11.7 防过时的三道防线

存储时排除可推导信息（根源）→ 回忆时附加过期警告（提醒）→ 推荐前要求验证（行动）。三个环节都有防线，比单一环节更稳健。

---

## 十二、总结

Claude Code 的 Memory 系统是一个**为 LLM 对话场景设计的持久化知识管理系统**。其核心创新：

1. **不存可推导信息**——最反直觉但最正确的决策。代码结构和 git 历史存了就会过时，过时记忆比没有记忆更有害。
2. **三层时间尺度**——模仿人类记忆机制，在成本和时效之间找到平衡。
3. **互斥写入路径**——主 agent 和后台 agent 不会同时处理同一段对话。
4. **文件系统即接口**——最大化透明度和可调试性。
5. **Eval 驱动迭代**——每个 prompt 改动都有可量化的 before/after。
6. **安全优先**——排除不可信配置源，防止路径遍历攻击。

这些设计模式不限于 Claude Code——任何需要跨 session 持久化上下文的 AI agent 系统都可以从中获益。

---

*本文基于 Claude Code v2.1.88 泄露源码的逐行分析。所有引用的文件路径、行号、函数名和注释均来自实际源码。*
