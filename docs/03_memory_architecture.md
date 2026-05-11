# Claude Code 源码泄露深度解析（三）：三层记忆架构——Self-Healing MEMORY.md

> **系列索引** | 本篇为第三篇：Claude Code 三层记忆系统深度解析

---

## 一、为什么 AI Agent 需要特殊的记忆系统？

传统的 AI 对话有一个根本性的限制：**无状态性**。每次对话开始，模型都是全新的，不记得上次说了什么。

Claude Code 面临的问题更加严峻：

- 一个真实的软件项目可能有数万个文件
- 用户可能连续工作数天、数周
- Agent 需要记住项目结构、历史决策、用户偏好、已知 Bug 等大量信息
- 但模型的上下文窗口（context window）是有限的

**最朴素的解决方案**：把所有信息都放入上下文。  
**问题**：这会很快超出上下文限制，而且大量无关信息会干扰模型的注意力，降低回答质量。

**Claude Code 的解决方案**：一个被研究者称为 **"Self-Healing Memory"（自愈记忆）** 的三层架构。

---

## 二、三层记忆架构详解

### 第一层：MEMORY.md — 轻量级指针索引

`MEMORY.md` 是整个记忆系统的**核心枢纽**，但它本身存储的不是数据，而是**指向数据的指针**。

**设计约束：**
- 每行约 **150 个字符**
- **始终加载到上下文中**（永久占用上下文窗口）
- 内容是结构化的指针列表，指向更详细的 topic files

**MEMORY.md 示例结构（推断）：**

```markdown
# Project Memory Index
[auth-system] → memory/topics/auth-system.md (last updated: 2026-03-28)
[database-schema] → memory/topics/db-schema.md (last updated: 2026-03-25)
[api-patterns] → memory/topics/api-patterns.md (last updated: 2026-03-27)
[known-issues] → memory/topics/known-issues.md (last updated: 2026-03-30)
[user-preferences] → memory/topics/user-prefs.md (last updated: 2026-03-29)

# Recent Decisions
[2026-03-30] Decided to use PostgreSQL over MySQL → memory/transcripts/session-2026-03-30.log:line:247
[2026-03-29] Auth system uses JWT with 7-day refresh → memory/topics/auth-system.md
```

这个设计的精妙之处：
- **全局可见**：Agent 在任何时候都知道有哪些主题可以检索
- **按需加载**：只有真正需要的 topic 才会被读取
- **极小开销**：整个索引文件只有几 KB

### 第二层：Topic Files — 按主题组织的知识库

Topic Files 是存储实际项目知识的文件，按主题组织在 `memory/topics/` 目录下：

```
memory/
└── topics/
    ├── auth-system.md       # 认证系统的所有知识
    ├── db-schema.md         # 数据库模式文档
    ├── api-patterns.md      # API 设计模式
    ├── known-issues.md      # 已知问题和临时方案
    ├── user-preferences.md  # 用户偏好设置
    └── deployment.md        # 部署相关知识
```

**关键特性：**
- **按需加载（On-Demand Fetch）**：Agent 只在需要特定领域知识时才读取对应文件
- **可以很详细**：没有严格的大小限制，可以包含完整的代码示例、决策记录等
- **由 Agent 自主维护**：Agent 在工作过程中会主动更新这些文件

### 第三层：Transcripts — 只 Grep 不全读的历史记录

会话历史原始记录存储在 `memory/transcripts/` 目录下，但有一个关键设计原则：

**这些文件从不被完整读回上下文。**

Agent 对 transcripts 的访问方式是：
- 使用 `grep` 命令查找特定标识符或关键词
- 定位到相关行并读取前后的有限上下文
- 将提取的片段而非完整记录放入上下文

这个设计解决了一个核心矛盾：需要保留完整历史（便于追溯），但又不能让历史占满上下文。

---

## 三、Strict Write Discipline：防止记忆污染

三层架构中最重要的设计约束之一是 **"严格写入纪律（Strict Write Discipline）"**：

**规则：Agent 只有在文件写入成功之后，才能更新 MEMORY.md 索引。**

```
尝试写入 topic file
    │
    ├── 成功 ──→ 更新 MEMORY.md 索引 ✓
    │
    └── 失败 ──→ 不更新索引，不记录失败 ✗
```

**为什么这很重要？**

如果 Agent 在写入失败的情况下仍然更新索引，会发生以下问题：
1. MEMORY.md 里记录了一个指向不存在文件的指针
2. 下次尝试访问该 topic 时失败
3. 模型可能会用它自己的"记忆"来填充这个空白，产生幻觉
4. 错误的信息污染整个记忆系统

这个"先写文件，后写索引"的两阶段提交模式，借鉴了数据库事务的思想。

---

## 四、记忆的自愈性：为什么叫 Self-Healing？

研究者之所以称其为"自愈记忆"，是因为系统设计了多重机制来维持记忆的一致性和准确性：

### 4.1 矛盾检测与解决

当 Agent 在工作中发现当前观察与记忆中的信息矛盾时，它会：
1. 识别矛盾
2. 以当前观察为准（更新更可靠）
3. 更新对应的 topic file
4. 在 MEMORY.md 中更新时间戳

### 4.2 从观察到事实的升华

记忆系统区分两种知识状态：
- **Tentative Observation（暂时观察）**：Agent 看到了某个现象，但还不确定其含义
- **Verified Fact（已验证事实）**：经过多次观察或显式验证确认的知识

随着 Agent 工作的深入，暂时观察会逐渐升华为已验证事实，存入 topic files。

### 4.3 AutoDream：睡眠时的记忆整合（第五篇详述）

这是最神奇的部分：当用户闲置时，一个后台守护进程会对记忆进行"整合"，这将在第五篇（KAIROS/AutoDream）中详细介绍。

---

## 五、与传统 RAG 的对比

Claude Code 的记忆架构与传统的 RAG（检索增强生成）有本质区别：

| 维度 | 传统 RAG | Claude Code 记忆系统 |
|---|---|---|
| **检索方式** | 向量相似度搜索 | 结构化指针 + grep |
| **索引更新** | 批量重建 | 实时增量更新 |
| **知识组织** | 按向量空间分布 | 按主题语义组织 |
| **上下文占用** | 动态注入检索结果 | MEMORY.md 常驻 + 按需加载 |
| **失败处理** | 检索失败返回空 | Strict Write Discipline 防止脏索引 |
| **记忆主权** | 外部数据库 | Agent 自主维护的文件系统 |

**最关键的区别**：传统 RAG 是被动的（等待查询），Claude Code 的记忆系统是主动的（Agent 主动维护、主动更新）。

---

## 六、memdir 模块：记忆目录管理

`memdir/` 目录包含记忆文件系统的管理逻辑：

### 6.1 目录结构管理

```typescript
// memdir 模块负责的核心操作（推断）
class MemDir {
  // 初始化项目记忆目录
  initialize(projectRoot: string): Promise<void>
  
  // 读取 MEMORY.md 索引
  readIndex(): Promise<MemoryIndex>
  
  // 原子性更新索引（先写文件，后写索引）
  updateTopic(topicId: string, content: string): Promise<void>
  
  // Grep transcripts
  grepTranscripts(pattern: string): Promise<GrepResult[]>
  
  // 获取记忆系统状态
  getStats(): Promise<MemStats>
}
```

### 6.2 文件锁机制

当多个 Agent（如在 Coordinator 模式下）同时工作时，记忆文件可能被并发写入。`memdir` 使用文件锁（file locks）防止竞争写入：

```
Agent A 试图写 auth-system.md
    │
    ├── 获取文件锁 ──→ 成功 ──→ 写入 ──→ 更新索引 ──→ 释放锁
    │
    └── 获取文件锁 ──→ 等待 Agent B 释放锁 ──→ 重试
```

---

## 七、从项目初始化到记忆积累

### 7.1 首次运行：CLAUDE.md vs MEMORY.md

Claude Code 支持两种类型的项目知识文件：

- **CLAUDE.md**：由用户手动编写的项目指令，类似 README，告诉 Agent 如何工作
- **MEMORY.md**：由 Agent 自主维护的动态记忆索引，记录 Agent 的"学习成果"

两者都会被加载到上下文，但维护者不同：
- CLAUDE.md：人类写，不会被 Agent 覆盖
- MEMORY.md：Agent 写，会随工作进展不断更新

### 7.2 记忆积累的生命周期

```
项目初始化
    │
    ▼
创建空的 MEMORY.md
    │
    ▼
首次对话：Agent 探索项目结构
    │
    ▼
发现重要信息 → 写入 topic file → 更新 MEMORY.md
    │
    ▼
持续工作 → 记忆不断丰富
    │
    ▼
用户闲置 → AutoDream 整合记忆（去除矛盾、提升事实确信度）
    │
    ▼
下次会话：加载 MEMORY.md → 快速恢复上下文
```

---

## 八、工程洞见与设计启示

这个三层记忆架构对 AI Agent 工程师有深刻的启示：

### 8.1 索引与数据分离

MEMORY.md（索引）和 Topic Files（数据）分离的设计，使得索引可以永远保持在上下文中而不占用太多空间。这是数据库索引思想在 LLM 架构中的应用。

### 8.2 宁可不记，不能记错

Strict Write Discipline 体现了一个重要原则：对于 LLM 系统，**错误的记忆比没有记忆更危险**。一条错误的"事实"会在模型的幻觉下被不断放大和引用，导致连锁错误。

### 8.3 grep 而非 RAG

使用 grep 而非向量检索来访问历史记录，是一个看似"降级"实则聪明的选择：
- **精确性更高**：grep 返回精确匹配，而向量检索返回"相似"内容
- **成本更低**：不需要维护向量数据库
- **可解释性更好**：可以清楚地知道 Agent 找到了什么

### 8.4 文件系统是最好的数据库

整个记忆系统建立在文件系统上，而非专用数据库。这带来了极大的灵活性：用户可以直接编辑这些文件，可以用 Git 版本化这些记忆，可以在不同机器间同步。

---

## 九、小结

Claude Code 的三层记忆架构代表了一种成熟的 AI Agent 记忆系统设计范式：

- **MEMORY.md**：小而精的常驻索引，是 Agent 的"目录"
- **Topic Files**：按需加载的主题知识库，是 Agent 的"百科全书"
- **Transcripts**：只 grep 不全读的历史档案，是 Agent 的"日记"

这三层相互配合，解决了 AI Agent 的核心挑战：**在有限的上下文窗口内，维持对复杂项目的完整理解**。

下一篇，我们将探讨 Claude Code 的多智能体协调系统——**Coordinator Mode**。

---

*本文基于公开技术分析报告，仅用于教育目的。*
