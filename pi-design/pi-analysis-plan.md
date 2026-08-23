# pi-analysis-plan

# Pi Agent 源码架构分析与数据分析智能体定制规划

## 一、Pi Agent 项目概览

### 1.1 项目定位

Pi 是一个**极简终端编码智能体框架**（Minimal Terminal Coding Harness），核心设计理念是：
- **可扩展而非可配置**：通过 TypeScript 扩展、Skills、Prompt Templates、Themes 来适配工作流，而非修改内部代码
- **自扩展编码智能体**：智能体可以自我扩展，添加新能力
- **多模式运行**：交互式、打印/JSON、RPC、SDK 嵌入

### 1.2 核心数据

| 指标 | 数值 |
| --- | --- |
| Stars | 55.6k |
| Forks | 6.6k |
| 最新版本 | v0.75.5 (2026-05-23) |
| 总提交 | 4,288+ |
| 许可证 | MIT |
| Node 要求 | >=22.19.0 |

### 1.3 Monorepo 架构

```
pi-monorepo/
├── packages/
│   ├── ai/              # @earendil-works/pi-ai — 统一多提供商 LLM API
│   ├── agent/           # @earendil-works/pi-agent-core — Agent 运行时
│   ├── coding-agent/    # @earendil-works/pi-coding-agent — 交互式编码 CLI
│   └── tui/             # @earendil-works/pi-tui — 终端 UI 库
├── .pi/                 # Pi 配置文件
├── scripts/             # 构建和发布脚本
└── package.json         # npm workspaces 配置
```

---

## 二、核心包深度解析

### 2.1 @earendil-works/pi-ai（LLM 统一层）

**职责**：封装 25+ 家 LLM 提供商，提供统一的流式 API

**支持的提供商**：
OpenAI、Anthropic、Google、Azure OpenAI、DeepSeek、NVIDIA NIM、Mistral、Groq、Cerebras、Cloudflare、xAI、OpenRouter、Vercel AI Gateway、ZAI、MiniMax、Together AI、GitHub Copilot、Amazon Bedrock、Fireworks、Kimi、Xiaomi MiMo 等

**核心 API**：

```tsx
// 获取模型
const model = getModel('openai', 'gpt-4o-mini');

// 流式对话
const stream = stream(model, context);
for await (const event of stream) {
  // text_delta, toolcall_start, thinking_delta, done, error...
}

// 非流式对话
const response = await complete(model, context);
```

**关键特性**：
- 自动模型发现与配置
- Token 和成本追踪
- 工具调用（Function Calling）统一接口
- 跨提供商会话切换（Context Serialization）
- TypeBox 类型安全的工具定义
- 图片输入/生成支持
- Thinking/Reasoning 统一接口

### 2.2 @earendil-works/pi-agent-core（Agent 运行时）

**职责**：有状态 Agent，管理工具执行、事件流、消息循环

**核心类：Agent**

```tsx
const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model: getModel("anthropic", "claude-sonnet-4-6"),
    tools: [myTool1, myTool2],
    messages: [],
  },
});

// 订阅事件
agent.subscribe((event) => {
  if (event.type === "message_update") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

// 发送提示
await agent.prompt("Hello!");
```

**事件流架构**：

```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { userMessage }
├─ message_end
├─ message_start   { assistantMessage }
├─ message_update  { partial... }      // 流式输出
├─ message_end
├─ turn_end
└─ agent_end
```

**带工具调用的扩展流程**：

```
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end
├─ tool_execution_start
├─ tool_execution_update  // 工具流式进度
├─ tool_execution_end
├─ message_start/end  { toolResultMessage }
├─ turn_end
├─ turn_start         // 下一轮：LLM 响应工具结果
├─ message_start      { assistantMessage }
└─ agent_end
```

**关键配置选项**：

| 选项 | 说明 |
| --- | --- |
| `convertToLlm` | AgentMessage[] → Message[] 转换（支持自定义消息类型） |
| `transformContext` | 上下文转换（消息裁剪、压缩） |
| `beforeToolCall` | 工具执行前拦截（权限控制） |
| `afterToolCall` | 工具执行后处理 |
| `toolExecution` | "parallel" / "sequential" |
| `steeringMode` / `followUpMode` | 消息队列模式 |
| `streamFn` | 自定义流函数（代理后端） |

### 2.3 @earendil-works/pi-coding-agent（编码 CLI）

**职责**：终端交互界面，提供编码智能体体验

**核心功能**：
- 交互式 TUI（终端 UI）
- 会话管理（JSONL 树结构，支持分支）
- 上下文压缩（Compaction）
- 工具：read、write、edit、bash
- Skills 系统（可复用的工具集）
- Extensions 系统（TypeScript 插件）
- Prompt Templates
- Themes

**运行模式**：

| 模式 | 说明 |
| --- | --- |
| 交互式 | 默认 TUI 模式 |
| 打印/JSON | `-p` 或 `--mode json` |
| RPC | `--mode rpc` 进程间通信 |
| SDK | 嵌入到自己的应用中 |

---

## 三、定制数据分析智能体 — 实施规划

> 所有技术决策以架构文档 [pi-data-agent-architecture](https://app.notion.com/p/pi-data-agent-architecture-38741d0c96f6803d9409d26fc6c7b288?pvs=21) 为准。本规划只讲落地步骤，设计取舍见架构文档对应章节。
> 

### 总原则（对齐架构文档）

- **单引擎**：只用 DuckDB（`@duckdb/node-api`），不引入 Polars / Pandas 多引擎切换；相关性、假设检验等用 Python 无状态执行。（架构 §1.6 / §7.1）
- **9 数据工具 + 1 交互工具**：复杂分析下沉到 Skill，不堆工具。（架构 §5.2 / §5.6.3）
- **安全先行**：P0 安全层在写任何业务工具之前就位。（架构 §3）
- **护城河 = Context Engineering**：数据字典懒加载 + 查询记忆三道闸 + 主动反问，三者回写 `agent.md` 形成闭环。（架构 §1.3 / §5.4–5.6）
- **隐私**：原始数据不出本地，只发结构化元数据 / 小样本；DuckDB 本地处理。（架构 §1.5）

### Phase 1：环境准备与源码研究（1-2 天）

#### Step 1.1：拉取并构建源码

```bash
git clone https://github.com/earendil-works/pi.git
cd pi
npm install --ignore-scripts   # 不运行生命周期脚本
npm run build                  # 构建所有包
./test.sh                      # 运行测试
./pi-test.sh                   # 从源码运行 pi
```

#### Step 1.2：必读源码（决定后续所有实现）

| 文件 | 目的 |
| --- | --- |
| `packages/agent/src/agent.ts` | Agent 类、生命周期 |
| `packages/agent/src/agent-loop.ts` | 核心循环、beforeToolCall / afterToolCall 拦截点 |
| `packages/agent/src/types.ts` | AgentTool、toolExecution、steeringMode / followUpMode |
| `packages/coding-agent/docs/` | 扩展（Extension）与 Skill 开发文档 |
| `packages/ai/README.md` | LLM 统一 API、流式与工具调用 |

> **核查点**：确认 `beforeToolCall` 的阻塞能力（能否在工具执行前暂停等用户输入）与 `promptConfirm` 形态——主动反问机制（Phase 3）直接复用它。（架构 §5.6.5）
> 

### Phase 2：安全层（P0）+ 工具集 + 引擎（3-5 天）

#### Step 2.1：P0 安全层（先于业务工具）

对齐架构 §3，在 `beforeToolCall` 统一接入 `securityCheck()`：

- **路径白名单**：文件操作限制在 `cwd`，越界拦截 + 确认。
- **危险动作黑名单**：`rm -rf`、无 WHERE 的 `DROP/DELETE`、`os.system`、网络请求、敏感路径（`~/.ssh` 等）。
- **读写门控**：读放行；写要确认；删强制确认。

```tsx
beforeToolCall: async ({ toolCall, args }) => {
  const verdict = await securityCheck(toolCall.name, args)
  if (!verdict.allowed) return { block: true, reason: verdict.reason }
  return undefined
}
```

#### Step 2.2：工具清单（9 数据工具 + 1 交互工具）

对齐架构 §5.2。**砍掉** spec 旧版的 `clean_data / correlation_analysis / statistical_test / generate_report`——这些下沉到 Skill。

| 工具 | 功能 | 说明 |
| --- | --- | --- |
| `load_data` | 加载本地文件到 DuckDB | CSV/JSON/Parquet/Excel |
| `connect_database` | 连接外部库 | DuckDB ATTACH（PG/MySQL/SQLite） |
| `describe_data` | 数据概览 | DESCRIBE + SUMMARIZE |
| `query_data` | 执行 DuckDB SQL | NL → SQL → DuckDB（非 Pandas） |
| `transform_data` | 数据转换 | CTAS 落新表 |
| `visualize` | 生成图表 | Python 无状态 matplotlib/plotly |
| `show_image` | TUI 展示图片 | — |
| `export_result` | 导出结果 | DuckDB COPY TO |
| `list_datasets` | 列出会话数据集 | — |
| `ask_clarification` | 主动反问（交互） | **不计入 9 个数据工具**（架构 §5.6.3） |

#### Step 2.3：DuckDB 引擎 + 大结果防撑爆

- 引擎：`@duckdb/node-api`，`.duckdb` 文件持久化 + WAL + 崩溃自恢复。（架构 §5.3）
- **大结果防撑爆**（架构 §5.2）：所有执行类工具只返回「摘要 + 元数据 + 落盘引用」，不把完整结果集塞进 tool result。`query_data` 返回前 N 行 + 总行数 + 列摘要 + 落盘路径。

### Phase 3：Context Engineering（护城河，3-5 天）

#### Step 3.1：数据字典懒加载 Hook

首次使用某表时触发：DESCRIBE → LLM 推断列语义 → 用户确认/修正 → 标记 `validated` / `AI-guessed` → 落 `data-dictionary.yaml`。（架构 §5.4）

#### Step 3.2：查询记忆三道闸

（架构 §5.5）① 过时闸（schema 指纹比对，MVP 后）② 容量闸（频次×新近×相关性加权淘汰，保留 3-5 条）③ 相关性闸（数据集指纹匹配召回）。MVP **只入库成功查询**。

#### Step 3.3：主动反问机制（差异化核心）

对齐架构 §5.6，**结构化选项**而非开放式提问：

- **工具层** `ask_clarification`：typed `Clarification` 契约（`question / why / options[]{ id,label,impliedAssumption } / allowFreeText / defaultIfSkip`）。
- **Hook 层** `src/hooks/active-questioning.ts`：`beforeToolCall` 拦 `query_data`，歧义命中强制 clarify。
- **Skill 层**：各场景选项模板（见架构 §6.3）。
- **回写**：答案写回 `agent.md` / 数据字典，同口径只问一次。
- **运行模式**：TUI 自定义渲染选项；非交互（`-p`/`--mode json`/RPC/SDK）走 `defaultIfSkip` 并声明口径。

#### Step 3.4：三层持久化

（架构 §8）Global（`~/.config/pi-data-agent/`：连接、偏好）/ Project（`./.pi-data-agent/`：`agent.md`、数据字典、查询记忆、`session.duckdb`）/ Session（内存临时态）。

### Phase 4：错误自修复 + Eval（2-3 天）

#### Step 4.1：错误自修复闭环（P0）

（架构 §9）`executeWithRecovery` 最多 3 次重试；相同错误连续 2 次立即停；每次重试对用户可见；最终失败附完整上下文（SQL + 错误 + schema + 样本）。

#### Step 4.2：Eval（MVP 末期引入）

（架构 §10）金标准任务 + `eval/regression.test.ts`。主动反问用例断言：`sql === null` 且 `clarification.options.length >= 2`、每选项带 `impliedAssumption`、`defaultIfSkip` 存在、同口径不重复反问。

### Phase 5：CLI 与交互界面（2-3 天）

- 复用 pi-coding-agent 的 TUI / 事件订阅；`pi-data chat` 交互、`pi-data analyze <file>` 自动分析。
- 选项渲染走扩展自定义渲染（已有自定义扩展在 TUI 内渲染先例）。

### Phase 6：Skill 体系（2-3 天）

（架构 §6）[agentskills.io](http://agentskills.io) 格式，`SKILL.md`（策略文字）+ `scripts/`（DuckDB SQL / Python）。五大 Skill：`data-exploration`（P0）、`visualization`（P0）、`database-analysis`（P0）、`data-cleaning`（P1）、`statistical-analysis`（P1）。获取策略：现成用 / 下载改造（审源码）/ 自己做。

---

## 四、项目文件结构（对齐架构 §11.1）

```
pi-data-agent/
├── src/
│   ├── index.ts              # 扩展入口，注册工具和钩子
│   ├── security.ts           # P0 安全层：白名单、黑名单、门控
│   ├── error-recovery.ts     # 错误自修复闭环
│   ├── persistence.ts        # 三层持久化读写
│   ├── tools/                # 9 个数据工具 + ask_clarification
│   ├── hooks/
│   │   ├── data-dictionary.ts    # 数据字典懒加载
│   │   ├── query-memory.ts       # 查询记忆三道闸
│   │   └── active-questioning.ts # 主动反问拦截
│   └── engine/
│       ├── duckdb.ts             # DuckDB 引擎（单引擎）
│       └── python-stateless.ts   # Python 无状态执行（统计/绘图）
├── skills/                   # 5 大 Skill（agentskills.io 格式）
│   ├── data-exploration/
│   ├── visualization/
│   ├── database-analysis/
│   ├── data-cleaning/
│   └── statistical-analysis/
├── eval/
│   └── regression.test.ts    # MVP 末期引入
├── config/
│   └── agent.md              # 稳定口径定义
├── package.json
└── README.md
```

---

## 五、关键技术决策（已对齐架构文档）

| 分析引擎 | **DuckDB 单引擎**（砍 Polars/Pandas 多引擎） | 降复杂度；DuckDB 内存映射 + 流式足够 GB 级（架构 §7） |
| --- | --- | --- |
| 维度 | 决策 | 理由 |
| Python 集成 | `child_process` 无状态调用（统计/绘图） | 简单无服务；不主推 FastAPI 微服务 |
| 数据存储 | 三层持久化（Global/Project/Session）+ `.duckdb` | 架构 §8 |
| 可视化 | matplotlib/plotly 出图 → `show_image` | 静态图 base64，TUI 展示 |
| 安全 | P0 安全层（白名单+黑名单+门控） | 架构 §3，先于业务工具 |
| 隐私 | 原始数据不出本地，仅元数据/小样本上行 | 架构 §1.5 |

> **与旧版 spec 的差异**：旧版 pandas/polars 多引擎、10 工具、FastAPI 微服务、弱安全、无护城河——均已按架构文档纠正。
> 

---

## 六、风险与挑战

1. **上下文窗口限制**：大结果撑爆上下文
    - 缓解：工具只返回摘要+元数据+落盘引用（架构 §5.2）；上下文压缩
2. **NL→SQL 准确度**：LLM 生成错误 SQL
    - 缓解：错误自修复闭环 max 3（架构 §9）；亮 SQL 给用户审计（架构 §1.4）
3. **口径漂移**：同一指标多种理解
    - 缓解：主动反问 + 数据字典 + `agent.md` 稳定口径，同口径只问一次（架构 §1.3/§5.6）
4. **Python 环境依赖**：用户需装 Python + 库
    - 缓解：一键安装脚本；核心路径尽量留在 DuckDB，Python 仅统计/绘图
5. **数据安全**：敏感数据经 LLM API
    - 缓解：数据不出本地、本地模型（Ollama）可选、脱敏（架构 §1.5）。

---

## 七、参考资源

- [Pi 官方文档](https://pi.dev/docs/latest)
- [Pi GitHub](https://github.com/earendil-works/pi)
- [Pi AI README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)
- [Pi Agent README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)
- [Pi Coding Agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- 架构文档（设计依据）：[pi-data-agent-architecture](https://app.notion.com/p/pi-data-agent-architecture-38741d0c96f6803d9409d26fc6c7b288?pvs=21)
