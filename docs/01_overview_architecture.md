# Claude Code 源码泄露深度解析（一）：事件始末与整体架构

> **系列索引**  
> 本系列共 8 篇，对 2026 年 3 月 31 日 Anthropic 意外泄露的 Claude Code 完整源码进行模块级深度分析。  
> 本篇为第一篇：事件经过 + 整体系统架构。

---

## 一、事件经过：史上最贵的 `.map` 文件

2026 年 3 月 31 日凌晨 4 点（UTC），Solayer Labs 实习生 **Chaofan Shou**（网名 @Fried_rice）在 X（原 Twitter）上发布了一条消息：

> "Claude Code 的源代码通过 npm registry 里的一个 `.map` 文件泄露了！"

他附上了直链：一个托管在 **Anthropic 自家 Cloudflare R2 存储桶**上的 ZIP 压缩包，任何人无需密码即可下载。

这条推文在几小时内引爆了整个开发者社区。

### 到底发生了什么？

#### Source Map 是什么？

当你用 TypeScript 编写代码，再用 Bun/Webpack/esbuild 等工具打包为生产环境的压缩 JS 时，构建工具会生成一个 `.map` 文件（Source Map）。它的作用是**将压缩后难以阅读的代码映射回原始源码**，方便调试时查看真正的报错位置。

Source Map 的内部结构大致如下：

```json
{
  "version": 3,
  "sources": ["../src/main.tsx", "../src/tools/BashTool.ts", "..."],
  "sourcesContent": [
    "// main.tsx 的完整原始源码",
    "// BashTool.ts 的完整原始源码",
    "..."
  ],
  "mappings": "AAAA,SAAS,OAAO..."
}
```

注意 `sourcesContent` 字段——它存储的是**所有原始文件的完整内容**，包括注释、内部常量、系统提示词，一字不漏。

#### Anthropic 的失误

问题出在 Claude Code 的构建工具链上：**Anthropic 选用了自家收购的 Bun 作为运行时和打包器**。Bun 的打包器默认启用 Source Map 生成，除非显式关闭。某次发布中，有人忘记在 `.npmignore` 里屏蔽 `*.map`，或者没有在构建配置里关闭 source map 生成。

结果：**v2.1.88 版本的 `@anthropic-ai/claude-code` npm 包里附带了一个 59.8 MB 的 `.map` 文件**，而这个文件里的 `sourcesContent` 字段指向了存放在 R2 上的完整源码 ZIP。

讽刺的是，代码里有一个专为防止内部信息泄露而设计的子系统叫做 **"Undercover Mode"**（卧底模式）——Anthropic 花费大量工程精力阻止 AI 在 git commit 里暴露内部代号，然后却把整个源码打包进了 npm 包里发布出去。

### 泄露规模

| 指标 | 数据 |
|---|---|
| 泄露版本 | `@anthropic-ai/claude-code` v2.1.88 |
| 文件数量 | ~1,906 个 TypeScript 文件 |
| 代码行数 | 512,000+ 行 |
| 压缩包大小 | 59.8 MB (.map 文件) |
| GitHub 镜像 | 数小时内出现数十个镜像仓库 |
| 最快破星记录 | claw-code 仓库 2 小时内超过 50,000 star |

Anthropic 随后发表声明：

> "今天早些时候，一次 Claude Code 发布包含了一些内部源码。没有敏感的客户数据或凭证被涉及或暴露。这是一次由人为错误导致的发布打包问题，不是安全漏洞。我们正在推出措施以防止这种情况再次发生。"

这是 Anthropic 在五天内的**第二次意外泄露**（五天前刚发生了 Claude Mythos 模型相关文件泄露），也是同类 Source Map 泄露事故的**第三次**（第一次在 2025 年 2 月）。

---

## 二、Claude Code 是什么？

在深入技术细节之前，先建立对 Claude Code 的基本认知。

Claude Code 是 Anthropic 于 2025 年推出的**命令行界面（CLI）AI 编码助手**，是目前市场上最受欢迎的 AI 编码 Agent 之一。

**核心商业数据（截至 2026 年 3 月）：**
- 年化经常性收入（ARR）：**25 亿美元**
- 企业客户占比：**80%**
- 用户包括：Uber、Netflix、Spotify、Salesforce、Snowflake 等

从外部看，它是一个可以在终端执行复杂编码任务的 AI 助手。从内部看，它是一个复杂的**多智能体操作系统**。

---

## 三、整体系统架构

### 3.1 技术栈

```
运行时:     Bun (Anthropic 收购)
语言:       TypeScript (严格模式)
UI 框架:    React + Ink (终端 React 渲染器)
打包工具:   Bun bundler
API 通信:   Anthropic API / Claude 4.6 系列
HTTP 客户端: Axios (讽刺地正是泄露当天遭受供应链攻击的库)
特征标志:   GrowthBook
```

### 3.2 目录结构总览

从泄露的仓库目录来看，Claude Code 被划分为以下主要模块：

```
claude-code/
├── main.tsx              # 主入口（785KB！）
├── assistant/            # KAIROS 持续助手系统
├── bootstrap/            # 启动初始化
├── bridge/               # IDE 桥接（JWT 认证）
├── buddy/                # Tamagotchi 宠物系统（BUDDY feature flag）
├── cli/                  # CLI 解析与入口点
├── commands/             # 85+ 斜杠命令
├── components/           # React 终端 UI 组件
├── constants/            # 系统常量（含系统提示词）
├── context/              # 上下文管理
├── coordinator/          # 多智能体协调器
├── entrypoints/          # 多种启动模式
├── hooks/                # React 状态钩子
├── ink/                  # 自定义终端渲染引擎
├── keybindings/          # 键盘绑定
├── memdir/               # 内存目录管理
├── migrations/           # 数据迁移
├── native-ts/            # 原生 TypeScript 扩展
├── outputStyles/         # 输出样式系统
├── plugins/              # 插件系统
├── query/                # 查询引擎
├── remote/               # 远程会话管理
├── schemas/              # Zod 类型验证 Schema
├── screens/              # 全屏 UI 组件
├── server/               # 本地 API 服务器
├── services/             # 核心服务层
│   ├── api/              # Claude API 封装
│   ├── compact/          # 上下文压缩
│   └── autoDream/        # 后台记忆整合
├── skills/               # 技能定义（含 /dream）
├── state/                # 全局状态管理
├── tasks/                # 任务执行引擎
├── tools/                # 40+ 内置工具
├── types/                # TypeScript 类型定义
├── upstreamproxy/        # 上游代理
├── utils/                # 工具函数
├── vim/                  # Vim 模式支持
└── voice/                # 语音接口（VOICE_MODE）
```

### 3.3 核心分层架构

Claude Code 的整体架构可以抽象为以下 6 层：

```
┌─────────────────────────────────────────────────────────┐
│                   用户交互层                              │
│  CLI / React+Ink Terminal UI / Voice / IDE Bridge        │
├─────────────────────────────────────────────────────────┤
│                   会话管理层                              │
│  REPL / 对话历史 / 上下文压缩(autoCompact) / 权限管理     │
├─────────────────────────────────────────────────────────┤
│                   Agent 执行层                           │
│  Tool Executor / 40+ Tools / BashSecurity / 权限沙箱      │
├─────────────────────────────────────────────────────────┤
│                   记忆与状态层                            │
│  三层 Memory 架构 / MEMORY.md / Topic Files / Transcripts │
├─────────────────────────────────────────────────────────┤
│                   多智能体协调层                          │
│  Coordinator Mode / Worker Agents / KAIROS Daemon        │
├─────────────────────────────────────────────────────────┤
│                   API 与安全层                           │
│  Claude API / Client Attestation / Anti-Distillation     │
└─────────────────────────────────────────────────────────┘
```

### 3.4 入口点多样性

`entrypoints/` 目录揭示了 Claude Code 支持多种运行模式：

| 入口点 | 说明 |
|---|---|
| `cli` | 标准命令行交互模式 |
| `sdk` | 供第三方调用的 SDK 模式 |
| `mcp` | MCP 协议服务器模式 |
| `coordinator` | 多智能体协调器模式 |
| `kairos` | 常驻后台守护进程模式（未发布）|

### 3.5 Feature Flag 系统：44 个编译时开关

Claude Code 使用 **GrowthBook** 作为特性标志系统，同时辅以编译时 Feature Flag。泄露的代码中发现了至少 **44 个未发布功能开关**：

**主要 Feature Flags：**

| Flag 名称 | 描述 | 状态 |
|---|---|---|
| `KAIROS` | 常驻自主守护进程 | 未发布 |
| `PROACTIVE` | 主动行为触发 | 未发布 |
| `BUDDY` | Tamagotchi 宠物系统 | 计划 2026/05 |
| `ULTRAPLAN` | 云端 30 分钟规划会话 | 未发布 |
| `VOICE_MODE` | 语音接口 | 未发布 |
| `BRIDGE_MODE` | IDE 桥接模式 | 部分发布 |
| `COORDINATOR` | 多智能体协调 | 部分发布 |
| `ANTI_DISTILLATION_CC` | 反蒸馏保护 | 内部启用 |
| `NATIVE_CLIENT_ATTESTATION` | 原生客户端证明 | 内部启用 |
| `PENGUIN_MODE` | 企鹅模式（含义未知） | 实验性 |

---

## 四、内部模型代号

泄露代码还暴露了 Anthropic 内部的模型命名体系：

| 内部代号 | 对应模型 | 状态 |
|---|---|---|
| Capybara | Claude 4.6（标准版） | 已发布 |
| Fennec | Claude Opus 4.6 | 已发布 |
| Tengu | 内部工具代号 | 内部使用 |
| Numbat | 未知新模型 | 测试阶段 |
| Mythos | 未来旗舰模型 | 开发中 |

其中特别值得关注的是关于 Capybara v8（最新版本）的性能数据：
- **虚假陈述率（false claims rate）：29-30%**（相比 v4 版本的 16.7% 有所退步）
- 存在"assertiveness counterweight"（强硬性反制权重），防止模型在重构时过于激进
- 存在"over-commenting"（过度注释）问题

这些真实的内部性能数据对竞争对手而言极具价值。

---

## 五、为什么这次泄露影响深远？

### 5.1 战略层面

对于 Anthropic 这家估值超过 600 亿美元、AI Coding 产品年收入 25 亿美元的公司而言，这次泄露不仅是技术失误，更是**战略机密的暴露**：

- **产品路线图暴露**：KAIROS、ULTRAPLAN、BUDDY 等未发布功能的完整实现细节
- **系统提示词暴露**：核心 Agent 行为的完整指令集
- **架构蓝图暴露**：多智能体协调、记忆系统等核心技术细节

### 5.2 安全层面

泄露同时发生了一个严重的巧合：**同日（2026/03/31 00:21-03:29 UTC）还发生了针对 `axios` npm 包的供应链攻击**，恶意版本包含远程访问木马（RAT）。在该时间窗口内通过 npm 安装 Claude Code 的用户可能同时受到两种威胁。

### 5.3 法律层面

数小时内，多个 GitHub 镜像仓库因 Anthropic DMCA 申诉而被下线。但一位韩国开发者 Sigrid Jin 将核心架构用 Python 从头重写，推出了 claw-code 仓库，并以"干净室重写"（clean-room reimplementation）主张规避版权限制——2 小时内超过 5 万 star，创 GitHub 历史记录。

---

## 六、系列预告

本系列后续文章将逐一深入分析 Claude Code 的各个核心模块：

| 篇次 | 主题 |
|---|---|
| 第二篇 | 核心 Agent 引擎与 40+ 工具系统 |
| 第三篇 | 三层记忆架构：Self-Healing MEMORY.md |
| 第四篇 | 多智能体协调器：Coordinator Mode |
| 第五篇 | KAIROS 自主守护进程与 AutoDream |
| 第六篇 | 安全机制：BashSecurity、权限模型与客户端证明 |
| 第七篇 | 反蒸馏机制、Undercover Mode 与特殊设计 |
| 第八篇 | 终端渲染引擎、BUDDY、ULTRAPLAN 与未发布功能 |

---

*本文基于公开的技术分析报告（VentureBeat、The Register、Alex Kim's Blog 等）及 GitHub 上的公开讨论，仅用于技术教育目的。*
