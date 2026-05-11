# Claude Code 源码泄露深度解析（四）：多智能体协调器——Coordinator Mode 与 Agent Swarms

> **系列索引** | 本篇为第四篇：多智能体协调器 (Coordinator Mode) 深度解析

---

## 一、为什么需要多智能体系统？

单个 AI Agent 有天然的局限性：
- **上下文窗口有限**：无法同时"关注"超大型代码库的所有部分
- **串行执行**：一次只能做一件事，复杂任务耗时很长
- **专注度问题**：在一个长任务中，模型注意力可能分散

Claude Code 的解决方案是：**让多个 Agent 分工协作**。

泄露的源码揭示了一个完整的多智能体架构，包含：
- **Coordinator Mode**（协调器模式）：一个 Orchestrator Agent 指挥多个 Worker Agent
- **Agent Swarms**（Agent 群）：并行 Agent 处理独立子任务
- **KAIROS**（将在下一篇讲解）：后台常驻 Agent 守护进程

---

## 二、Coordinator Mode：核心架构

### 2.1 协调器的角色分离

Coordinator Mode 定义了两种明确的角色：

```
┌─────────────────────────────────────────────────────┐
│                 Orchestrator Agent                   │
│  (协调器 - 使用 coordinatorMode.ts)                  │
│                                                     │
│  职责：                                              │
│  · 理解用户的高层目标                                 │
│  · 将任务分解为独立子任务                              │
│  · 分配子任务给 Worker Agents                         │
│  · 监控执行进度                                      │
│  · 整合所有结果                                       │
│  · 质量控制（"不要橡皮图章弱工作"）                   │
└─────────────────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Worker A     │  │ Worker B     │  │ Worker C     │
│ (前端分析)   │  │ (后端 API)   │  │ (测试文件)   │
│              │  │              │  │              │
│ · 有限工具   │  │ · 有限工具   │  │ · 有限工具   │
│ · 独立上下文 │  │ · 独立上下文 │  │ · 独立上下文 │
│ · Token 配额 │  │ · Token 配额 │  │ · Token 配额 │
└──────────────┘  └──────────────┘  └──────────────┘
```

### 2.2 最关键的发现：协调算法是一个 Prompt，不是代码

这是泄露代码中最令研究者震惊的设计之一。

在 `coordinatorMode.ts` 中，Orchestrator Agent 的核心"算法"不是 if-else 逻辑，不是调度算法，而是**一段 System Prompt**。

这段 Prompt 包含了大量的工作纪律指令，几个典型的原文（根据报道整理）：

> **"Do not rubber-stamp weak work."**  
> （不要草率认可质量差的工作）

> **"You must understand findings before directing follow-up work. Never hand off understanding to another worker."**  
> （你必须在指导后续工作之前理解结论。永远不要将理解转移给另一个 Worker）

> **"If a worker's output contradicts previous findings, investigate before accepting."**  
> （如果 Worker 的输出与之前的发现矛盾，先调查再接受）

这些指令构成了 Orchestrator 的"工作伦理"——不是通过代码约束，而是通过自然语言教导 AI 如何做一个好的管理者。

**这揭示了一个深刻的设计哲学**：当你的 Agent 足够智能时，**行为规范可以直接用自然语言描述**，而不必编写复杂的约束代码。

---

## 三、任务分解策略

### 3.1 并行 vs 串行的判断

Coordinator 在分配任务时会评估任务之间的依赖关系：

```
任务依赖图分析：

A ──→ B ──→ D
│         ▲
└──→ C ───┘

分析结果：
- A 需要先做（其他任务依赖它）
- B 和 C 可以并行（都依赖 A，互不依赖）
- D 需要等 B 和 C 都完成

执行计划：
1. 串行执行 A
2. 并行执行 B 和 C
3. 串行执行 D
```

### 3.2 Worker 的工具授权

Coordinator 在创建 Worker 时会明确指定该 Worker 可以使用哪些工具，遵循**最小权限原则**：

- 一个只需要分析代码的 Worker：只给 `FileReadTool`、`GrepTool`
- 一个需要运行测试的 Worker：添加 `BashTool`（但可能限制可执行的命令）
- 一个需要提交代码的 Worker：添加 `GitCommitTool`

这样即使某个 Worker 的行为出现偏差，它能造成的破坏也是有限的。

### 3.3 Token 预算管理

Coordinator 为每个 Worker 分配 Token 预算：

```typescript
// 推断的 Worker 配置结构
interface WorkerConfig {
  task: string;           // 任务描述
  tools: ToolName[];      // 授权工具列表
  tokenBudget: number;    // Token 配额
  maxDepth: number;       // 最大递归深度（防止 Agent 无限创建子 Agent）
  timeout: number;        // 超时时间
}
```

当 Worker 即将耗尽 Token 预算时，它会：
1. 生成一个部分结果摘要
2. 返回给 Coordinator
3. Coordinator 决定是否继续（创建新 Worker）或接受部分结果

---

## 四、Agent Swarms：并行执行的工程实现

### 4.1 Swarm 的创建与管理

泄露代码显示，Agent Swarms 是通过 **Node.js Worker Threads** 或**独立进程**实现的，而不是简单的异步调用。

这意味着：
- 每个 Worker Agent 真正并行运行（利用多核 CPU）
- Worker 之间内存隔离（避免状态污染）
- Coordinator 通过 IPC（进程间通信）与 Worker 通信

### 4.2 结果汇聚机制

```
Worker A 结果 ──┐
Worker B 结果 ──┼──→ Coordinator 整合逻辑 ──→ 最终结果
Worker C 结果 ──┘
```

整合逻辑包括：
- **冲突检测**：如果两个 Worker 对同一问题得出不同结论
- **去重**：多个 Worker 可能发现同一个问题
- **优先级排序**：根据重要性对发现进行排序
- **质量验证**："Do not rubber-stamp weak work"在这里体现

### 4.3 失败处理

单个 Worker 失败不会导致整个 Swarm 崩溃：

```
Worker 失败
    │
    ├── 重试（最多 N 次）
    │
    ├── 降级（跳过该 Worker，接受部分结果）
    │
    └── 上报给 Coordinator（让 Coordinator 决定下一步）
```

---

## 五、与 IDE 的深度集成：Bridge Mode

### 5.1 JWT 认证的 IDE 桥接

`bridge/` 目录实现了 Claude Code 与 IDE 插件之间的通信桥接。这个桥接使用 **JWT（JSON Web Token）认证**，这揭示了 Anthropic 的安全设计思想：

- Claude Code 终端进程是**服务端**
- IDE 扩展（VS Code 插件等）是**客户端**
- 两者之间的通信需要 JWT 验证

这是**零信任架构（Zero-Trust）**的体现：即使在同一台机器上，也不默认信任。

### 5.2 为什么不用 GitHub Copilot 那种紧耦合架构？

GitHub Copilot 直接在 IDE 进程内运行。Claude Code 选择了松耦合的桥接架构，好处是：
- **IDE 无关性**：同一个后端可以连接多种 IDE
- **独立生命周期**：Claude Code 进程崩溃不会影响 IDE
- **安全隔离**：IDE 扩展不能直接访问 Claude Code 的内部状态

---

## 六、coordinatorMode.ts：代码结构分析

根据泄露信息，`coordinatorMode.ts` 的大致结构：

```typescript
// coordinator/coordinatorMode.ts（根据泄露报告推断）

interface CoordinatorState {
  goal: string;           // 高层目标
  plan: TaskNode[];       // 任务分解计划
  workers: WorkerAgent[]; // 活跃的 Worker Agents
  findings: Finding[];    // 已收集的发现
  status: 'planning' | 'executing' | 'integrating' | 'done';
}

// Coordinator 的系统提示词（核心"算法"）
const COORDINATOR_SYSTEM_PROMPT = `
You are an expert software engineering coordinator...
[工作纪律指令]
- Do not rubber-stamp weak work
- Understand findings before directing follow-up
- Investigate contradictions before accepting
[任务管理指令]  
- Decompose goals into independent, parallel tasks
- Assign minimal required tools to each worker
- Monitor token budgets and task completion
...
`;

class CoordinatorMode {
  async run(goal: string, context: Context): Promise<CoordinatorResult> {
    // 1. 规划阶段：让模型分解任务
    const plan = await this.planTasks(goal, context);
    
    // 2. 执行阶段：并行启动 Workers
    const results = await this.executeParallel(plan, context);
    
    // 3. 整合阶段：合并所有 Worker 的输出
    const integrated = await this.integrate(results, context);
    
    return integrated;
  }
}
```

---

## 七、多智能体系统的实际应用场景

根据代码架构，Coordinator Mode 最适合以下场景：

### 7.1 大型代码库重构

```
用户：将整个项目从 JavaScript 迁移到 TypeScript

Coordinator 分解：
- Worker 1：分析所有 .js 文件，生成迁移清单
- Worker 2：迁移 src/utils/，运行测试
- Worker 3：迁移 src/components/，运行测试  
- Worker 4：迁移 src/api/，运行测试
- Worker 5：更新 tsconfig.json、package.json
- Worker 6：整体集成测试

Coordinator 整合：合并所有 Worker 的迁移结果，处理冲突
```

### 7.2 全代码库安全审计

```
用户：检查项目中所有可能的 SQL 注入漏洞

Coordinator 分解（按模块并行）：
- Worker 1：分析 controllers/ 目录
- Worker 2：分析 models/ 目录
- Worker 3：分析 routes/ 目录
- Worker 4：分析 middleware/ 目录

所有 Worker 并行执行，结果汇聚后去重、排优先级
```

### 7.3 跨 Repo 功能开发

```
用户：在 frontend 和 backend 同步实现新的认证功能

Coordinator 分解：
- Worker 1：分析 frontend 现有认证代码
- Worker 2：分析 backend 现有 API
- Coordinator 设计统一接口方案
- Worker 3：实现 frontend 变更
- Worker 4：实现 backend 变更
- Worker 5：同步更新集成测试
```

---

## 八、工程洞见：用 Prompt 替代代码

Coordinator Mode 最重要的工程启示是：

**"协调逻辑可以是自然语言，而不必是代码"**

传统的多任务调度系统需要：
- 状态机（State Machine）
- 调度算法（Scheduling Algorithm）
- 冲突解决规则（Conflict Resolution Rules）
- 质量检查代码

Claude Code 的做法是：用系统提示词描述"一个优秀的技术 Lead 应该怎么工作"，然后让 AI 来模仿这个行为。

这不是偷懒，而是**认识到 LLM 的本质是从人类行为中蒸馏出来的最佳实践**。让 LLM 模仿一个好的 Tech Lead，比让程序员写出一个好的 Tech Lead 算法，可能反而更容易。

当然，这也带来了风险：模型行为可能因模型版本升级而改变，难以进行精确的行为测试。

---

## 九、小结

Claude Code 的多智能体协调系统展示了几个重要的设计原则：

1. **角色分离**：Orchestrator 和 Worker 有明确不同的职责和能力
2. **最小权限**：Worker 只获得完成任务所必需的工具
3. **Prompt 即算法**：协调逻辑通过自然语言描述，而非硬编码
4. **零信任通信**：即使内部组件也通过 JWT 认证
5. **弹性设计**：单个 Worker 失败不影响整体

下一篇，我们将深入 Claude Code 最神秘的模块：**KAIROS 自主守护进程与 AutoDream 记忆整合系统**。

---

*本文基于公开技术分析报告，仅用于教育目的。*
