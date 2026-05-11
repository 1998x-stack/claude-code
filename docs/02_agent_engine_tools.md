# Claude Code 源码泄露深度解析（二）：核心 Agent 引擎与 40+ 工具系统

> **系列索引** | 本篇为第二篇：核心 Agent 引擎 + Tool System 深度解析

---

## 一、Agent 引擎核心：从 REPL 到自主执行

### 1.1 主入口：785KB 的 main.tsx

Claude Code 的主入口文件 `main.tsx` 体积高达 **785KB**，这在前端/Node 项目中极为罕见。这个文件是整个 Agent 系统的神经中枢，它完成以下核心工作：

1. **解析启动模式**（CLI / SDK / MCP / Coordinator / KAIROS）
2. **初始化上下文**（项目检测、Git 状态、权限体系）
3. **启动 React+Ink 终端 UI**
4. **驱动主 Agent 循环**（接收用户输入 → 调用 Claude API → 执行工具 → 展示结果）

### 1.2 Agent 主循环设计

Claude Code 的核心执行模型是一个**工具调用反馈循环（Tool-Use Feedback Loop）**：

```
用户输入
    │
    ▼
┌─────────────────────────────────────────┐
│           构建系统提示词                  │
│  (含权限状态、记忆摘要、项目上下文)         │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│         调用 Claude API                  │
│  (含当前工具列表 + 对话历史)               │
└─────────────────────────────────────────┘
    │
    ▼
    ┌── 模型返回文本响应 ──→ 渲染到终端
    │
    └── 模型请求工具调用 ──→ 执行工具
                                │
                                ▼
                        ┌──────────────┐
                        │  BashSecurity │
                        │  权限检查      │
                        │  用户确认      │
                        └──────────────┘
                                │
                                ▼
                          工具执行结果
                                │
                                ▼
                         追加到对话历史
                                │
                                └──→ 回到"调用 Claude API"
```

这个循环持续运行，直到模型不再请求任何工具调用，或者用户中断为止。

### 1.3 Context 管理：autoCompact 压缩机制

当对话历史过长（接近模型上下文窗口上限）时，Claude Code 会触发 **autoCompact** 机制：

**工作原理：**
1. 检测当前 token 使用量接近阈值
2. 启动一个独立的 Claude 会话
3. 请求模型将当前对话历史压缩为结构化摘要
4. 用摘要替换历史记录，继续会话

**一个极具工程价值的真实案例：**

在 `autoCompact.ts` 的注释中，Anthropic 工程师直接写道：

> "BQ 2026-03-10：1,279 个会话出现了 50+ 次连续失败（最多 3,272 次），每天全球浪费约 25 万次 API 调用。"

**修复方案：** `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`

三行代码，每天节省 25 万次 API 调用。这个注释完美展示了数据驱动工程的价值——用真实线上数据驱动决策，连修复的原因和依据都写进注释里。

### 1.4 Prompt Cache 优化：14 个缓存断点追踪器

当你每个 token 都要付费时，**Prompt Cache 命中率**就是一个账务问题，不只是性能问题。

`promptCacheBreakDetection.ts` 追踪 **14 个可能导致 prompt cache 失效的因素**，包括：

- 模式切换（如从普通模式切到 Coordinator 模式）
- 权限状态变化
- 工具列表动态变化
- 系统提示词动态段变化

代码中有一个标记为 `DANGEROUS_uncachedSystemPromptSection()` 的函数，警告开发者：**在系统提示词中添加任何动态内容都会破坏缓存，成本极高**。

多个"粘性锁存器"（sticky latches）机制确保一旦某种模式被激活，就不会因为中间状态变化而频繁重置 cache。

---

## 二、Tool System：40+ 工具的分类设计

### 2.1 工具总览

Claude Code 内置了超过 **40 个工具**，分为几个主要类别：

#### 文件系统工具

| 工具名 | 功能 |
|---|---|
| `FileReadTool` | 读取文件内容（支持部分读取、行范围） |
| `FileWriteTool` | 写入/创建文件 |
| `FileEditTool` | 精确编辑文件（str_replace 模式） |
| `FileDeleteTool` | 删除文件 |
| `DirectoryListTool` | 列出目录内容 |
| `FileSearchTool` | 全局文件搜索 |
| `GrepTool` | 内容搜索（支持正则） |

#### 代码执行工具

| 工具名 | 功能 |
|---|---|
| `BashTool` | 执行 Shell 命令（核心工具，有专门的安全子系统）|
| `NodeTool` | 执行 Node.js 代码片段 |
| `PythonTool` | 执行 Python 代码片段 |

#### 网络与 API 工具

| 工具名 | 功能 |
|---|---|
| `WebFetchTool` | 获取网页内容 |
| `WebSearchTool` | 搜索网络 |

#### 多智能体工具

| 工具名 | 功能 |
|---|---|
| `AgentTool` | 生成子 Agent（递归 Agent 调用） |
| `TaskTool` | 创建并管理后台任务 |
| `CoordinatorTool` | 协调多个 Worker Agent |

#### Git 与版本控制工具

| 工具名 | 功能 |
|---|---|
| `GitCommitTool` | 创建 commit（含 Undercover Mode）|
| `GitDiffTool` | 查看 diff |
| `GitLogTool` | 查看提交历史 |
| `PRReviewTool` | 代码审查辅助 |

#### 记忆与状态工具

| 工具名 | 功能 |
|---|---|
| `MemoryReadTool` | 读取 MEMORY.md 及 topic files |
| `MemoryWriteTool` | 更新记忆索引 |
| `TodoReadTool` | 读取任务列表 |
| `TodoWriteTool` | 更新任务列表 |

### 2.2 Tool Schema 设计模式

所有工具都遵循统一的 Schema 设计，使用 **Zod** 进行运行时类型验证：

```typescript
// Tool.ts 中的基础接口设计（根据泄露内容推断）
interface Tool<TInput, TOutput> {
  name: string;
  description: string;  // 这里写给模型看的描述，至关重要
  inputSchema: ZodSchema<TInput>;
  
  // 权限检查：在执行前决定是否需要用户确认
  needsPermission: (input: TInput, context: Context) => PermissionLevel;
  
  // 实际执行函数
  execute: (input: TInput, context: Context) => Promise<TOutput>;
  
  // 用于展示的格式化函数
  formatResult: (output: TOutput) => string;
}
```

工具描述（`description`）是写给 Claude 模型看的自然语言说明，这些措辞的质量直接影响模型选择工具的准确性。Anthropic 在这些描述上显然花了大量精力进行 prompt engineering。

### 2.3 AgentTool：递归 Agent 架构

`AgentTool` 是 Claude Code 最强大的工具之一，允许主 Agent **生成子 Agent** 来并行处理子任务。

**设计原理：**

```
主 Agent (Orchestrator)
    │
    ├─── AgentTool 调用 1 ──→ 子 Agent A (分析前端代码)
    ├─── AgentTool 调用 2 ──→ 子 Agent B (分析后端 API)
    └─── AgentTool 调用 3 ──→ 子 Agent C (查找相关测试)
                                        │
                                        ▼
                              子 Agent 返回结果
                                        │
                                        ▼
                           主 Agent 整合所有结果
```

每个子 Agent 都有独立的上下文窗口和工具调用能力，但受到以下限制：
- **工具白名单**：子 Agent 只能使用主 Agent 授权的工具子集
- **递归深度限制**：防止无限嵌套
- **Token 预算分配**：每个子 Agent 有独立的 token 配额

---

## 三、BashTool：23 项安全检查的工程设计

BashTool 是整个系统中最危险也是最重要的工具。允许 AI Agent 执行任意 Shell 命令，必须有严密的安全机制。

### 3.1 bashSecurity.ts：23 项安全检查

`bashSecurity.ts` 包含 **23 个按序执行的安全检查**，这是一个真正的**命令行安全专用威胁模型**：

#### 第一类：命令黑名单

```
rm -rf /
dd if=/dev/zero of=/dev/sda
mkfs.*
fdisk /dev/
...
```

对已知的危险命令进行精确匹配拦截。

#### 第二类：Zsh 特有威胁（18 个被禁用的 Zsh 内建命令）

这是代码中最令人惊喜的发现之一。Claude Code 有**专门针对 Zsh 的威胁模型**，拦截了 18 个 Zsh 特有的内建命令，包括：

- **Zsh 等号展开攻击**：`=curl` 在 Zsh 中等价于 `$(which curl)`，可以绕过对 `curl` 命令的权限检查
- **IFS 空字节注入**：通过操控 IFS 变量改变命令解析行为

在 HackerOne 的安全审计中，研究人员发现了一个通过畸形 token 绕过权限检查的方法，这个漏洞也被修复并加入了安全检查列表。

#### 第三类：Unicode 安全

- **零宽字符注入**：Unicode 零宽空格（U+200B）可以插入命令中，视觉上看起来是合法命令，实际上是两个不同的命令
- **双向控制字符**：RTL override 等字符可以颠倒显示顺序，欺骗用户确认

#### 第四类：管道与重定向分析

对于复合命令，系统会递归分析每个管道段和重定向目标，确保所有子命令都通过安全检查。

### 3.2 权限三级体系

```
┌─────────────────────────────────┐
│     Level 3：自动执行             │
│  只读操作、低风险命令              │
│  (ls, cat, git status...)       │
└─────────────────────────────────┘
         ↑ 需要风险评估
┌─────────────────────────────────┐
│     Level 2：单次确认             │
│  写操作、网络请求、文件删除等       │
│  每次执行前询问用户                │
└─────────────────────────────────┘
         ↑ 风险较高
┌─────────────────────────────────┐
│     Level 1：永久拒绝或需要特殊授权│
│  系统级操作、危险命令              │
│  rm -rf, dd, 格式化磁盘等         │
└─────────────────────────────────┘
```

用户可以通过"永久允许此命令"选项来提升特定命令的权限级别，这个授权会被保存到本地配置文件。

### 3.3 命令沙箱与超时

每个 Bash 命令都在独立的子进程中执行，并有：
- **执行超时**：防止无限挂起的命令
- **输出大小限制**：防止输出溢出
- **进程组管理**：确保子进程被正确清理

---

## 四、85+ 斜杠命令系统

### 4.1 命令分类

`commands/` 目录包含 **85+ 个斜杠命令**，分为以下类别：

**Git 工作流命令：**
```
/commit          - 智能生成 commit 信息
/pr              - 创建 Pull Request
/review          - 代码审查
/diff            - 显示差异
/log             - 查看历史
```

**记忆与项目管理：**
```
/memory          - 查看/编辑 MEMORY.md
/todo            - 管理任务列表
/project         - 项目信息
/init            - 初始化项目配置
```

**多智能体命令：**
```
/agent           - 创建子 Agent
/coordinator     - 启动协调器模式
/dream           - 触发记忆整合（KAIROS）
/parallel        - 并行任务执行
```

**调试与诊断：**
```
/cost            - 查看当前 session 的 API 开销
/tokens          - 查看 token 使用情况
/compact         - 手动触发上下文压缩
/clear           - 清除对话历史
```

**实验性命令（feature flag 保护）：**
```
/ultraplan       - 启动 30 分钟远程规划会话
/kairos          - 切换到常驻模式
/voice           - 启动语音接口
```

### 4.2 命令执行架构

斜杠命令并不是简单的 CLI 命令，而是完整的 TypeScript 函数，可以：
- 访问完整的 Agent 上下文
- 调用任意工具
- 修改系统提示词
- 触发多 Agent 工作流

这使得 Claude Code 的斜杠命令更像是 **IDE 插件**，而不是普通的命令行参数。

---

## 五、工程洞见：从 tools.ts 里学到什么

### 5.1 工具描述即 Prompt Engineering

每个工具的 `description` 字段不仅是文档，更是**直接影响模型行为的 Prompt**。Anthropic 在这些描述上花了大量工程时间：

- 描述何时**应该**使用这个工具
- 描述何时**不应该**使用这个工具（负面示例）
- 说明工具的边界条件和注意事项

这与 Claude Code 表现出的超强工具选择能力直接相关。

### 5.2 输入验证双保险

所有工具输入经过两道验证：
1. **Zod Schema 结构验证**：确保类型正确
2. **业务逻辑验证**：如文件路径不能是 `..`，命令不能含危险模式

### 5.3 结果格式化的重要性

每个工具的 `formatResult` 函数经过精心设计，确保返回给模型的内容：
- 足够简洁（避免占用过多上下文窗口）
- 包含模型做下一步决策所需的所有信息
- 失败时提供清晰的错误信息和可能的解决方向

---

## 六、小结

Claude Code 的 Agent 引擎和工具系统展示了一个成熟的工业级 AI Agent 的设计范式：

1. **工具即接口**：工具定义 Agent 能做什么，描述决定 Agent 什么时候做
2. **安全是第一公民**：BashTool 的 23 项安全检查说明 Anthropic 认真对待了 Agent 执行任意代码的风险
3. **成本驱动架构**：autoCompact、prompt cache 优化等机制说明 Token 成本直接影响架构决策
4. **递归 Agent 模式**：AgentTool 的设计为多智能体协作提供了基础

下一篇我们将深入分析 Claude Code 最令人惊艳的技术创新之一：**三层记忆架构**。

---

*本文基于公开技术分析报告，仅用于教育目的。*
