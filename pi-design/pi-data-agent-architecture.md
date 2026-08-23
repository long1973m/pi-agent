# Pi Data Agent 技术架构设计

基于 Pi Agent 框架的个人数据分析代理

v1.0 | 2025-06-22 | 架构设计文档

---

## 1. 项目定位与核心原则

### 1.1 目标用户

被取数拖累的泛分析角色：

- 数据分析师（重复取数占用 30%+ 时间）
- 数据产品经理（需要快速验证口径）
- 运营 / 增长 / 创业者（无 SQL 能力但有分析需求）

### 1.2 价值主张

| 层级 | 目标 | 底线 / 差异化 |
| --- | --- | --- |
| 取数层 | 无感 + 可信 | 底线：SQL 必须对、口径必须准 |
| 分析层 | 主动反问 | 差异化：不是等用户问，而是主动追问 |

### 1.3 护城河：Context Engineering

真正的壁垒不是模型能力，而是**业务上下文工程**：

- 业务口径定义（什么算"活跃用户"）
- Schema 语义标注（字段含义、枚举值解释）
- 样本数据特征（分布、异常值、缺失模式）
- 历史查询模式（高频口径、失败教训）

### 1.4 设计哲学

让用户会怀疑、不盲信

- 亮 SQL：每次查询都展示生成的 SQL
- 摊口径假设：主动声明"这里假设活跃=最近7天有登录"
- 主动说不确定："基于当前数据无法确认因果关系，只能呈现相关性"

### 1.5 隐私原则

- **原始数据不离开本地**，仅结构化元数据 / 小样本按需发送
- 本地模型（Ollama）为**高级可选项**，不作主推
- 默认使用云端 LLM API，但数据在本地 DuckDB 处理

### 1.6 第一原则

绝不重复造轮子

能用 DuckDB 就不用自研引擎；能引用现成 Skill 就不重写；能调 CLI 工具就不写代码。

---

## 2. 整体架构

```
flowchart TB
subgraph User["用户层"]
U["自然语言提问"]
end
subgraph Base["Pi Agent Base"]
LLM["LLM API"]
RT["Agent Runtime"]
TUI["TUI 界面"]
end
subgraph Sec["安全层 (P0)"]
WL["路径白名单"]
BL["危险动作黑名单"]
CF["读写确认门控"]
end
subgraph Ext["Pi Data Agent Extension"]
CT["自定义工具 (9个)"]
EH["事件钩子"]
PS["持久化层"]
ER["错误自修复"]
end
subgraph Exec["执行层"]
DB["DuckDB 嵌入式引擎"]
PY["Python 无状态执行"]
end
subgraph Skills["Skill 体系"]
S1["数据探索"]
S2["数据清洗"]
S3["统计分析"]
S4["可视化"]
S5["数据库分析"]
end
U --> TUI
TUI --> RT
RT --> LLM
RT --> Sec
Sec --> Ext
Ext --> Exec
Ext --> Skills
Skills --> Exec
Exec --> PS
ER --> RT
```

### 2.1 四层架构说明

| 层级 | 组件 | 职责 |
| --- | --- | --- |
| Layer 1 | Pi Agent Base | LLM API 调用、Agent 运行时、TUI 交互界面 |
| Layer 2 | Security Layer | 路径白名单、危险动作黑名单、读写确认门控 |
| Layer 3 | Extension | 自定义工具、事件钩子、持久化、错误恢复 |
| Layer 4 | Execution + Skills | DuckDB 嵌入式引擎 + Python 无状态执行 + 5 大 Skill |

---

## 3. 安全层 (P0)

### 3.1 路径白名单

文件操作被限制在当前工作目录 (`cwd`) 内。任何越界访问被拦截并要求用户确认。

```typescript
// 路径白名单检查
function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const cwd = path.resolve(process.cwd());
  return resolved.startsWith(cwd) || resolved.startsWith(ALLOWED_GLOBAL_PATHS);
}
```

### 3.2 危险动作黑名单

| 危险动作 | 示例 | 拦截策略 |
| --- | --- | --- |
| 递归删除 | `rm -rf /`, `rm -rf *` | 完全拦截 + 告警 |
| 数据销毁 SQL | `DROP TABLE`, `DELETE FROM` (无 WHERE) | 拦截 + 强制确认 |
| 系统命令 | `os.system()`, `subprocess.call` | 完全拦截 |
| 网络请求 | `curl`, `fetch`, `requests.get` | 拦截 + 确认 |
| 敏感路径 | `~/.ssh`, `/etc/passwd`, `~/.env` | 完全拦截 |

### 3.3 读写确认门控

| 操作类型 | 策略 | 说明 |
| --- | --- | --- |
| 读取 (Read) | 放行 | 白名单内路径直接读取 |
| 写入 (Write) | 确认 | 展示影响范围，用户确认后执行 |
| 删除 (Delete) | 强制确认 | 必须显式输入确认码 |

### 3.4 securityCheck() 代码

```typescript
async function securityCheck(
  action: string,
  target: string,
  content?: string
): Promise<SecurityResult> {
  // 1. 路径白名单检查
  if (!isPathAllowed(target)) {
    return { allowed: false, reason: 'PATH_OUT_OF_BOUND', target };
  }

  // 2. 危险动作黑名单检查
  const dangerMatch = DANGEROUS_PATTERNS.find(p =>
    action.match(p.regex) || (content && content.match(p.regex))
  );
  if (dangerMatch) {
    return { allowed: false, reason: 'DANGEROUS_ACTION', detail: dangerMatch.name };
  }

  // 3. 读写确认门控
  if (action === 'write') {
    const confirmed = await promptConfirm(`写入文件: ${target}\n确认执行?`);
    if (!confirmed) return { allowed: false, reason: 'USER_DENIED' };
  }
  if (action === 'delete') {
    const confirmed = await promptForceConfirm(`删除: ${target}`);
    if (!confirmed) return { allowed: false, reason: 'USER_DENIED' };
  }

  return { allowed: true };
}
```

---

## 4. 功能矩阵与实现选择

### 4.1 数据加载

| 功能 | 实现选择 | 优先级 | 说明 |
| --- | --- | --- | --- |
| CSV / JSON / Parquet 加载 | Skill | P0 | DuckDB 原生 COPY / read_csv_auto |
| Excel 加载 (.xlsx) | Extension | P0 | sheet 选择 + 类型推断 |
| 数据库连接 (PostgreSQL / MySQL / SQLite) | Extension | P0 | DuckDB ATTACH + 扫描 schema |
| API / URL 数据获取 | CLI | P1 | curl + jq 管道 |
| 云存储 (S3 / GCS) | Extension | P2 | DuckDB httpfs 扩展 |

### 4.2 数据探索与清洗

| 功能 | 实现选择 | 优先级 | 说明 |
| --- | --- | --- | --- |
| 数据概览 (shape, dtypes, nulls) | Extension | P0 | DESCRIBE + SUMMARIZE |
| 数据字典懒加载 | Extension | P0 | 首次使用时触发，用户确认 |
| 缺失值处理 | Skill | P1 | 删除 / 填充 / 标记策略 |
| 异常值检测 | Skill | P1 | IQR / Z-score / 业务规则 |
| 类型转换 / 格式标准化 | Skill | P1 | 日期解析、货币单位统一 |

### 4.3 数据分析

| 功能 | 实现选择 | 优先级 | 说明 |
| --- | --- | --- | --- |
| SQL 查询生成与执行 | Core | P0 | NL → SQL → DuckDB |
| 聚合统计 (GROUP BY, CTE) | Core | P0 | DuckDB 原生支持 |
| 窗口函数分析 | Skill | P1 | 留存、同期群 |
| 相关性 / 回归分析 | Skill | P1 | Python stateless 执行 |
| 时序分析 | Skill | P2 | 趋势、季节性、预测 |

### 4.4 可视化

| 功能 | 实现选择 | 优先级 | 说明 |
| --- | --- | --- | --- |
| 表格展示 | Core | P0 | TUI 表格渲染 |
| 柱状图 / 折线图 / 饼图 | Skill | P0 | matplotlib / plotly 生成图片 |
| 散点图 / 热力图 | Skill | P1 | 相关性矩阵可视化 |
| 交互式图表 | Skill | P2 | HTML 输出 + 浏览器打开 |

### 4.5 导出与结果

| 功能 | 实现选择 | 优先级 | 说明 |
| --- | --- | --- | --- |
| CSV / JSON / Parquet 导出 | Extension | P0 | DuckDB COPY TO |
| Excel 导出 | Extension | P1 | 多 sheet 支持 |
| 图表图片导出 | Skill | P0 | PNG / SVG 保存到本地 |
| 分析报告生成 (Markdown) | Skill | P1 | 结构化报告模板 |

---

## 5. 核心扩展详解

### 5.1 项目结构

```
pi-data-agent/
├── src/
│   ├── index.ts              # 扩展入口
│   ├── security.ts           # 安全层
│   ├── error-recovery.ts     # 错误自修复
│   ├── persistence.ts        # 持久化层
│   ├── types.ts              # 类型定义
│   ├── tools/                # 9 个工具实现
│   │   ├── load-data.ts
│   │   ├── connect-database.ts
│   │   ├── describe-data.ts
│   │   ├── query-data.ts
│   │   ├── transform-data.ts
│   │   ├── visualize.ts
│   │   ├── show-image.ts
│   │   ├── export-result.ts
│   │   └── list-datasets.ts
│   ├── hooks/                # 事件钩子
│   │   ├── data-dictionary.ts
│   │   └── query-memory.ts
│   └── engine/               # 执行引擎
│       ├── duckdb.ts
│       └── python-stateless.ts
├── skills/                   # Skill 目录（agentskills.io 格式）
│   ├── data-exploration/
│   │   ├── SKILL.md          # 策略文字
│   │   └── scripts/          # 可执行 SQL / Python
│   ├── data-cleaning/
│   ├── statistical-analysis/
│   ├── visualization/
│   └── database-analysis/
├── config/                   # 配置文件
│   └── agent.md              # 稳定口径定义
└── package.json
```

### 5.2 工具清单 (9个)

| 工具名 | 功能 | 输入 | 输出 |
| --- | --- | --- | --- |
| `load_data` | 加载本地文件到 DuckDB | 文件路径、格式选项 | 数据集名称、行数、列信息 |
| `connect_database` | 连接外部数据库 | 连接字符串 / DSN | schema 列表、表列表 |
| `describe_data` | 数据概览与统计 | 数据集名称 | shape、dtypes、nulls、样本 |
| `query_data` | 执行 SQL 查询 | SQL 语句 | 查询结果、执行时间 |
| `transform_data` | 数据转换 (CTAS) | SQL 转换语句 | 新数据集名称 |
| `visualize` | 生成图表 | 数据集、图表类型、字段映射 | 图片路径 |
| `show_image` | 在 TUI 中展示图片 | 图片路径 | TUI 渲染 |
| `export_result` | 导出结果到文件 | 数据集、格式、路径 | 文件路径 |
| `list_datasets` | 列出当前会话数据集 | 无 | 数据集列表、来源、行数 |

**大结果防撑爆上下文**

所有执行类工具（`query_data`、`describe_data`、`transform_data` 等）**只返回「摘要 + 元数据 + 落盘文件引用」**，不把完整结果集塞进 tool result 返回值。

- `query_data`：返回前 N 行预览 + 总行数 + 列统计摘要 + 结果落盘路径
- `describe_data`：返回统计摘要（已是聚合结果，天然小）
- `transform_data`：返回影响行数 + 新表名 + 落盘路径
- LLM 如需查看完整结果，通过 `export_result` 导出后用 `show_image` 或文件引用

### 5.3 DuckDB 嵌入式引擎

核心依赖：`@duckdb/node-api`

- Python stateless：Python 脚本无状态执行，不维护连接
- .duckdb 文件持久化：会话数据自动保存到本地文件
- WAL (Write-Ahead Log)：保证事务安全
- Auto-restart：进程崩溃后自动恢复连接

```typescript
// DuckDB 引擎初始化
import { DuckDBInstance } from '@duckdb/node-api';

class DuckDBEngine {
  private db: DuckDBInstance;
  private dbPath: string;

  async init(projectPath: string) {
    this.dbPath = path.join(projectPath, '.pi-data-agent', 'session.duckdb');
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = await DuckDBInstance.create(this.dbPath);
    return this.db.connect();
  }

  async restart() {
    // 自动恢复：重新连接现有 .duckdb 文件
    this.db = await DuckDBInstance.create(this.dbPath);
    return this.db.connect();
  }
}
```

### 5.4 数据字典懒加载 Hook

```
sequenceDiagram
    actor U as 用户
    participant A as Pi Data Agent
    participant D as 数据字典Hook
    participant DB as DuckDB
    participant L as LLM
    U->>A: "分析 users 表的留存"
    A->>D: 首次使用 users 表?
    D->>DB: DESCRIBE users
    DB-->>D: 列信息
    D->>L: 请推断每列语义
    L-->>D: 字段含义猜测
    D->>U: 请确认以下字段理解是否正确
    U->>D: 确认 / 修正
    D->>D: 标记 validated / AI-guessed
    D-->>A: 返回标注后的数据字典
    A->>A: 继续执行查询
```

### 5.5 查询记忆三道闸

| 闸口 | 机制 | 触发条件 | 分期 |
| --- | --- | --- | --- |
| ① 过时闸 | Schema 指纹比对 + 语义过时检测 | 表结构变更时标记历史查询为过时；语义性变化标记可疑 | v0.2 |
| ② 容量闸 | 频次 x 新近 x 相关性 加权淘汰 | 保留 3-5 条高频查询，超容按加权分淘汰 | MVP |
| ③ 相关性闸 | 数据集指纹匹配 | 仅召回涉及当前数据集的查询 | MVP |

**分层落位策略**

- 稳定口径 → `agent.md`（人工维护，版本控制）
- 高频查询 → 动态记忆（自动维护，容量限制）
- 冷历史 → 按需召回（v0.2+，向量检索）

**失败查询处理**

MVP 策略：只存成功的高频查询

MVP 阶段查询记忆**仅入库成功的查询**，不存裸失败记录。失败查询的完整处理规则（含 `status: 'failed'`、错误分类、失败模式学习）推到 v0.2。

```typescript
interface QueryMemoryEntry {
  sql: string;
  naturalLanguage: string;
  datasetFingerprint: string;
  schemaFingerprint: string;
  useCount: number;           // 使用频次
  lastUsedAt: number;         // 最近使用时间
  relevanceScore: number;     // 相关性加权分
  createdAt: number;
  // v0.2 扩展字段：
  // status: 'success' | 'failed' | 'outdated';
  // errorMessage?: string;
  // failureCategory?: string;
}
```

### 5.6 主动反问机制 (Active Questioning)

> 差异化护城河：不是等用户问，而是主动追问；交互形态采用结构化选项——给 2-4 个「自带口径」的选项让用户选，而非开放式提问。

#### 5.6.1 触发策略

| 触发口 | 场景 | 例子 |
| --- | --- | --- |
| 歧义口 | 请求有多种合理解读（口径 / 范围 / 粒度不明） | "分析活跃用户" → 活跃定义？时间窗？ |
| 分叉口 | 一步做完，下一步有多条都合理且代价不同 | EDA 完成 → 流失归因 / 渠道对比 / 异常下钻？ |
| 风险口 | 要基于一个未确认假设继续执行之前 | "我按『最近 7 天登录 = 活跃』算，确认？" |

**不触发**：意图明确且低风险时直接执行，只「亮 SQL + 摊假设」，不打断（见 §1.4）。这条写死，避免主动反问退化成噪音。

#### 5.6.2 输出契约（typed，非散文）

```typescript
interface Clarification {
  question: string              // 一句话问题
  why: string                   // 为什么问：我注意到的歧义 / 异常
  options: Array<{
    id: string
    label: string               // 短选项
    impliedAssumption: string   // 选它 = 采纳这个口径
  }>                            // 控制在 2-4 个
  allowFreeText: true           // 永远允许用户自定义（对应 "Other"）
  defaultIfSkip: {              // 用户说"你定"时：自动选默认 + 声明
    optionId: string
    declaration: string         // 如"已按最近 7 天活跃口径执行，需调整请告知"
  }
}
```

- 每个选项自带 `impliedAssumption` → 选选项本身就是「摊口径」（§1.4）。
- `defaultIfSkip` → 用户说「你定」时自动选默认并声明，绝不死等。这是「主动」与「烦人」的分界线。

#### 5.6.3 四层落位（避免退化成长 Prompt）

| 层 | 放什么 | 作用 |
| --- | --- | --- |
| 工具层 `ask_clarification` | typed 契约 + 选项渲染（交互工具，**不计入 9 个数据工具**） | LLM 可主动反问；eval 可断言 |
| Hook 层 `src/hooks/active-questioning.ts` | `beforeToolCall` 拦 `query_data`，歧义命中则强制 clarify | 触发逻辑在代码里，不靠模型自觉 |
| Skill 层 `SKILL.md` | 各场景的选项模板（见 §6.3 示例） | 只放内容，不放强制 |
| `agent.md` / 数据字典 / 查询记忆 | 回写已确认口径 | 同口径只问一次（见 5.6.4） |

**双入口并存**：工具式（LLM 主动调用）给「能力」，Hook 式（系统强制）给「兜底」。只做工具式会掉回「靠模型自觉」的坑。

#### 5.6.4 收敛机制：同口径只问一次

反问的答案必须回写 `agent.md` / 数据字典 / 查询记忆；下次同类提问直接复用已确认口径，不再弹选项——除非 schema 变更触发过时闸（§5.5）。这把「主动反问 + 数据字典 + 查询记忆」串成 Context Engineering 闭环（§1.3），让它越用越懂用户口径，而非每次都问。

#### 5.6.5 运行模式适配

| 模式 | 行为 |
| --- | --- |
| 交互式 TUI | 自定义渲染可选项，暂停等待用户选择 |
| 非交互（-p / --mode json / RPC / SDK） | 不弹选项，直接走 `defaultIfSkip`，在输出中声明所用口径 |

- 中途暂停：复用安全层 `securityCheck()` 的 `promptConfirm` 阻塞模式（§3.4），把「是 / 否确认」扩展为「多选项选择」。
- 选项渲染：TUI 采用扩展自定义渲染（已有自定义扩展在 TUI 内渲染的先例，风险低）；接收选择需接入 TUI 输入循环，同属扩展能力。点选 vs 输入编号的具体形态：待核实（回 Pi 源码确认）。
- 并行冲突：触发 clarify 时强制把 `toolExecution` 切回 `sequential`，避免其它并行工具继续执行。

#### 5.6.6 Eval 钩子（对接 §10.2）

- 模糊提问应触发 clarify：`sql === null` 且 `options.length > 0`。
- 每个选项必须带 `impliedAssumption`；`defaultIfSkip` 必须存在。
- 已确认口径不得重复反问（同一提问连续两次，第二次不应再 clarify）。

---

## 6. Skill 体系设计

### 6.1 Skill 定义

Skill = **文字说明** + **可执行脚本** + **标准引用**

- 文字：描述该 Skill 的适用场景、输入输出、注意事项
- 可执行脚本：DuckDB SQL 或 Python 代码片段
- 标准引用：关联的业务口径、数据字典条目

### 6.2 五大 Skill

| Skill | 优先级 | 功能范围 | 包含脚本 |
| --- | --- | --- | --- |
| data-exploration | P0 | 数据概览、分布分析、快速洞察 | DESCRIBE, SUMMARIZE, 频数统计 |
| data-cleaning | P1 | 缺失值、异常值、重复值、格式标准化 | 清洗模板、规则脚本 |
| statistical-analysis | P1 | 描述统计、假设检验、相关性、回归 | Python statsmodels |
| visualization | P0 | 图表选择、渲染、导出 | matplotlib / plotly 模板 |
| database-analysis | P0 | 数据库元数据分析、性能诊断 | 系统表查询、索引分析 |

### 6.3 Skill 文件格式示例

`SKILL.md` = YAML frontmatter（元信息）+ 可执行脚本 + 主动反问模板。以 `data-exploration` 为例。

**① Frontmatter（元信息）**

```yaml
---
name: data-exploration
version: 1.0.0
priority: P0
description: |
  快速探索数据集的结构、分布和关键特征。
  适用于首次接触新数据时的快速摸底。
tags: [exploration, profiling, duckdb]
---
```

**② 可用脚本（DuckDB SQL）**

以下脚本中的占位符在运行时由实际表名 / 列名替换：

```sql
-- 1. 基础概览
DESCRIBE {table_name};
SUMMARIZE {table_name};

-- 2. 列分布分析
SELECT
  '{column}' AS column_name,
  COUNT(DISTINCT {column}) AS unique_count,
  COUNT(*) FILTER (WHERE {column} IS NULL) AS null_count,
  MIN({column}) AS min_val,
  MAX({column}) AS max_val
FROM {table_name};

-- 3. 高频值分析
SELECT {column}, COUNT(*) AS cnt
FROM {table_name}
GROUP BY {column}
ORDER BY cnt DESC
LIMIT 20;
```

**③ 主动反问模板（对接 §5.6，结构化选项而非开放式提问）**

用户使用此 Skill 时，Agent 弹出「自带口径」的选项，而非抛开放式问题：

```yaml
clarifications:
  - question: "分析范围是？"
    why: "未指定子集，口径会影响后续所有统计"
    options:
      - { id: all,    label: "整体分布", impliedAssumption: "全表，不加过滤" }
      - { id: subset, label: "特定子集", impliedAssumption: "需补 WHERE 条件" }
    allowFreeText: true
    defaultIfSkip: { optionId: all, declaration: "已按全表口径执行，需调整请告知" }
  - question: "时间范围？"
    why: "表含时间字段，默认全量可能掺入历史脏数据"
    options:
      - { id: full,   label: "全部时间", impliedAssumption: "不加时间过滤" }
      - { id: recent, label: "最近 N 天", impliedAssumption: "需指定 N" }
    allowFreeText: true
    defaultIfSkip: { optionId: full, declaration: "已按全部时间口径执行，需调整请告知" }
```

### 6.4 Skill 获取策略

| 策略 | 适用场景 | 示例 |
| --- | --- | --- |
| 现成用 | DuckDB 原生语法、标准 SQL | 直接引用官方文档示例 |
| 下载改造 | 社区 Skill 不完全匹配 | 审源码（联网/依赖/危险操作）→ 适配 DuckDB + 安全层 → fork 修改 |
| 自己做 | 业务特定口径、无现成方案 | 留存分析、同期群模板 |

---

## 7. 大数据处理策略

### 7.1 单引擎策略：砍掉 Polars + 三引擎切换

决策：MVP 阶段只保留 DuckDB

原方案考虑 DuckDB / Polars / Pandas 三引擎切换，但增加了复杂度和维护成本。**MVP 阶段只保留 DuckDB 单引擎**，后续根据实际瓶颈再扩展。

### 7.2 DuckDB 核心能力

| 能力 | 说明 | 适用场景 |
| --- | --- | --- |
| 内存映射 | 数据超出内存时自动换出到磁盘 | GB 级数据集 |
| 流式处理 | 结果集分块返回，避免内存爆炸 | 大结果集导出 |
| 并行执行 | 自动多线程查询执行 | CPU 密集型聚合 |
| 压缩存储 | 列式存储 + 高效压缩 | 磁盘空间敏感场景 |

### 7.3 采样策略

当数据量过大时，优先使用采样而非全量：

```sql
-- 分层随机采样（按类别分层）
SELECT * FROM large_table
SAMPLE 10%;

-- 按组分层采样
SELECT * FROM large_table
USING SAMPLE 1000 ROWS
STRATIFY BY category;

-- 系统采样（每 N 行取一行）
SELECT * FROM large_table
WHERE rowid % 100 = 0;
```

---

## 8. 配置持久化方案

### 8.1 三层持久化架构

```
flowchart TB
    subgraph Global["全局层 (Global)"]
        G1["~/.config/pi-data-agent/"]
        G2["connections.yaml"]
        G3["user-preferences.yaml"]
    end
    subgraph Project["项目层 (Project)"]
        P1["./.pi-data-agent/"]
        P2["agent.md"]
        P3["data-dictionary.yaml"]
        P4["query-memory.yaml"]
        P5["session.duckdb"]
    end
    subgraph Session["会话层 (Session)"]
        S1["内存中的临时状态"]
        S2["当前数据集列表"]
        S3["本次查询历史"]
    end
    Global --> Project
    Project --> Session
    Session --> Project
```

### 8.2 数据持久化选择

| 数据类型 | 存储位置 | 格式 | 说明 |
| --- | --- | --- | --- |
| 数据库连接 | Global | YAML | 加密存储连接字符串 |
| 数据字典 | Project | YAML | 字段语义、业务口径 |
| 稳定口径 | Project | Markdown | `agent.md`，版本控制 |
| 查询记忆 | Project | YAML | 仅成功的高频查询记录（MVP） |
| 用户偏好 | Global | YAML | 输出格式、确认习惯 |
| 会话数据 | Project | .duckdb | 加载的数据集、中间结果 |

### 8.3 状态恢复代码模式

```typescript
async function restoreSession(projectPath: string): Promise<SessionState> {
  const state: SessionState = {
    datasets: [],
    queryMemory: [],
    dataDictionary: {},
  };

  // 1. 恢复数据字典
  const dictPath = path.join(projectPath, '.pi-data-agent', 'data-dictionary.yaml');
  if (await fs.exists(dictPath)) {
    state.dataDictionary = yaml.parse(await fs.readFile(dictPath, 'utf-8'));
  }

  // 2. 恢复查询记忆
  const memoryPath = path.join(projectPath, '.pi-data-agent', 'query-memory.yaml');
  if (await fs.exists(memoryPath)) {
    state.queryMemory = yaml.parse(await fs.readFile(memoryPath, 'utf-8'));
  }

  // 3. 恢复 DuckDB 连接（自动加载 .duckdb 文件）
  await duckdbEngine.init(projectPath);

  // 4. 扫描当前数据集
  state.datasets = await duckdbEngine.listTables();

  return state;
}
```

---

## 9. 错误自修复闭环 (P0)

### 9.1 自修复流程

```
flowchart TD
A["执行操作"] --> B{"成功?"}
B -->|是| C["返回结果"]
B -->|否| D["捕获错误"]
D --> E["提取错误详情"]
E --> F["发送给 LLM"]
F --> G{"重试次数 < 3?"}
G -->|是| H["LLM 自修正"]
H --> A
G -->|否| I["停止 + 告警用户"]
I --> J["附带完整错误上下文"]
```

### 9.2 实现规则

| 规则 | 说明 |
| --- | --- |
| 最大 3 次重试 | 超过 3 次直接停止，避免无限循环 |
| 相同错误 3 次停止 | 连续相同错误立即终止，不浪费 token |
| 完整错误上下文 | 包含 SQL、错误信息、schema、数据样本 |
| 对用户可见 | 每次重试都展示给用户，不静默修复 |
| 最终错误附加 | 最终失败时附带完整调试信息 |

### 9.3 executeWithRecovery() 代码

```typescript
async function executeWithRecovery(
  operation: () => Promise<any>,
  context: ExecutionContext,
  maxRetries: number = 3
): Promise<ExecutionResult> {
  let lastError: Error | null = null;
  let retryCount = 0;
  const errorHistory: string[] = [];

  while (retryCount < maxRetries) {
    try {
      const result = await operation();
      return { success: true, data: result, retries: retryCount };
    } catch (error) {
      lastError = error as Error;
      const errorSignature = extractErrorSignature(error);

      // 相同错误连续出现，立即终止
      if (errorHistory.filter(e => e === errorSignature).length >= 2) {
        break;
      }
      errorHistory.push(errorSignature);

      // 构建修复提示
      const recoveryPrompt = buildRecoveryPrompt({
        originalQuery: context.sql,
        error: error.message,
        schema: context.schema,
        sample: context.sample,
        attempt: retryCount + 1,
      });

      // 通知用户
      ui.showMessage(`尝试自修复 (${retryCount + 1}/${maxRetries})...`);

      // 请求 LLM 修正
      const corrected = await llm.generate(recoveryPrompt);
      context.sql = corrected.sql;
      retryCount++;
    }
  }

  // 最终失败
  return {
    success: false,
    error: lastError?.message,
    errorContext: buildFullErrorContext(context, errorHistory),
    retries: retryCount,
  };
}
```

---

## 10. 评估体系 (Eval)

MVP 末期引入

评估体系不在 MVP 初期建设，而是在核心功能稳定后（MVP 末期）引入，避免过早优化。

### 10.1 金标准任务设计

| 任务 | 场景 | 评估标准 | 难度 |
| --- | --- | --- | --- |
| 基础取数 | "查询上个月的活跃用户" | SQL 正确性、执行成功 | 简单 |
| 口径对齐 | "活跃用户的定义是什么？" | 与 agent.md 定义一致 | 中等 |
| 异常检测 | "发现数据中的异常" | 发现预设异常、不误报 | 中等 |
| 可视化选择 | "展示用户增长趋势" | 图表类型合适、信息完整 | 中等 |
| 主动反问 | 模糊提问时的追问质量 | 追问相关、帮助澄清 | 困难 |

### 10.2 回归测试流程

```typescript
// eval/regression.test.ts
import { describe, it, expect } from 'vitest';
import { PiDataAgent } from '../src';

describe('金标准回归测试', () => {
  const agent = new PiDataAgent();

  it('基础取数 - 活跃用户', async () => {
    const result = await agent.query('查询上个月的活跃用户');
    expect(result.sql).toContain('active');
    expect(result.sql).toContain('last_month');
    expect(result.success).toBe(true);
  });

  it('口径对齐 - 活跃定义', async () => {
    const result = await agent.query('活跃用户的定义是什么');
    expect(result.response).toMatch(/7天|最近登录/);
    expect(result.assumptionsDeclared).toBe(true);
  });

  it('主动反问 - 模糊提问应触发结构化 clarify', async () => {
    const result = await agent.query('分析一下数据');
    expect(result.sql).toBeNull();                 // 不应直接生成 SQL
    expect(result.clarification).not.toBeNull();
    expect(result.clarification.options.length).toBeGreaterThanOrEqual(2);
    // 每个选项必须自带口径假设（§1.4 摊假设）
    for (const opt of result.clarification.options) {
      expect(opt.impliedAssumption).toBeTruthy();
    }
    // 必须有默认口径，绝不死等（§5.6.2）
    expect(result.clarification.defaultIfSkip).toBeDefined();
  });

  it('收敛 - 已确认口径不重复反问', async () => {
    await agent.query('分析一下数据', { confirmedScope: 'all' });
    const second = await agent.query('再分析一下数据');
    expect(second.clarification).toBeNull(); // 同口径只问一次（§5.6.4）
  });
});
```

---

## 11. 项目结构与实现路线

### 11.1 完整项目结构

```
pi-data-agent/
├── src/
│   ├── index.ts                  # 扩展入口，注册工具和钩子
│   ├── security.ts               # 安全层：白名单、黑名单、门控
│   ├── error-recovery.ts         # 错误自修复闭环
│   ├── persistence.ts            # 三层持久化读写
│   ├── types.ts                  # TypeScript 类型定义
│   ├── tools/
│   │   ├── load-data.ts          # P0：文件加载
│   │   ├── connect-database.ts   # P0：数据库连接
│   │   ├── describe-data.ts      # P0：数据描述
│   │   ├── query-data.ts         # P0：SQL 查询
│   │   ├── transform-data.ts     # P0：数据转换
│   │   ├── visualize.ts          # P0：图表生成
│   │   ├── show-image.ts         # P0：图片展示
│   │   ├── export-result.ts      # P0：结果导出
│   │   └── list-datasets.ts      # P0：数据集列表
│   ├── hooks/
│   │   ├── data-dictionary.ts    # P0：数据字典懒加载
│   │   └── query-memory.ts       # P0：查询记忆三道闸
│   ├── engine/
│   │   ├── duckdb.ts             # P0：DuckDB 引擎
│   │   └── python-stateless.ts  # P1：Python 无状态执行
│   └── utils/
│       ├── schema-fingerprint.ts
│       └── dataset-fingerprint.ts
├── skills/
│   ├── data-exploration/         # P0
│   │   ├── SKILL.md              # 策略文字（agentskills.io 格式）
│   │   └── scripts/             # 可执行 DuckDB SQL / Python
│   ├── data-cleaning/            # P1
│   │   ├── SKILL.md
│   │   └── scripts/
│   ├── statistical-analysis/     # P1
│   │   ├── SKILL.md
│   │   └── scripts/
│   ├── visualization/            # P0
│   │   ├── SKILL.md
│   │   └── scripts/
│   └── database-analysis/        # P0
│       ├── SKILL.md
│       └── scripts/
├── eval/
│   └── regression.test.ts        # MVP 末期引入
├── config/
│   └── agent.md                  # 稳定口径定义模板
├── package.json
├── tsconfig.json
└── README.md
```

### 11.2 瘦身路线图

| 阶段 | 周期 | 核心交付 |
| --- | --- | --- |
| **MVP** | 2-3 周 | 单引擎 DuckDB + 9 工具 + 1 Skill (data-exploration) + 数据字典懒加载 + 错误自修复 + 安全门控 + 查询记忆最小版（容量闸 + 相关性闸） |
| **v0.2** | 2 周 | + 4 Skills + 过时闸（schema 指纹 + 语义过时） + 失败查询入库 + 冷历史按需召回 + 可视化增强 |
| **v0.3** | 2 周 | 数据库连接增强 + 统计分析 Skill + Eval 体系 + 性能优化 |
| **v0.4+** | 持续 | + 多引擎支持(Polars) + 云存储 + 协作功能 + 插件市场 |

### 11.3 MVP 外功能清单 (P1/P2)

- P1 数据清洗 Skill（缺失值、异常值、重复值）
- P1 统计分析 Skill（假设检验、回归）
- P1 Excel 导入/导出
- P1 API / URL 数据获取
- P2 时序分析
- P2 交互式图表
- P2 云存储 (S3 / GCS)
- P2 分析报告生成 (Markdown)

---

## 12. 竞品差异化总结

### 12.1 客观对比

| 竞品 | 定位 | 我方优势 | 我方劣势 |
| --- | --- | --- | --- |
| ChatGPT Advanced Data Analysis | 通用 AI + 代码解释器 | 本地数据不离开本机；数据库原生连接；可主动反问 | 模型能力不如 GPT-4o；通用知识覆盖不足 |
| Claude Projects | 上下文感知的项目助手 | 专门的数据分析工具链；SQL 生成与执行一体化；查询记忆 | 无 Claude 的长上下文优势；品牌认知度低 |
| OpenInterpreter | 本地代码执行代理 | 更聚焦数据分析场景；DuckDB 嵌入式；安全门控更严格 | 通用性不如 OI；社区生态较小 |
| PandasAI | Pandas + LLM 封装 | 不绑定 Pandas；DuckDB 性能更优；Skill 驱动可扩展 | 无 Pandas 生态成熟；用户习惯需培养 |
| Vanna AI | RAG-based NL2SQL | 本地执行；主动反问；查询记忆；不依赖向量数据库 | NL2SQL 准确度可能不如 Vanna（训练后） |
| 传统 BI 工具(Tableau / PowerBI) | 企业级可视化平台 | 零配置启动；自然语言交互；成本极低 | 可视化能力弱；企业级功能缺失；协作能力弱 |

### 12.2 核心差异化点

1. **本地数据 + 可信取数**：原始数据不离开本地，SQL 透明可审计
2. **数据库原生**：DuckDB 嵌入式，非内存 DataFrame 方案
3. **可主动反问**：不是被动等用户问，而是主动追问澄清
4. **查询记忆**：三道闸机制，历史查询可复用、可追踪
5. **Skill 驱动**：可扩展的分析模板体系，社区可共享

### 12.3 Vanna 表述修正

**重要澄清**

Vanna AI 是 **RAG-based NL2SQL** 方案，通过向量检索相似问题-SQL 对来生成查询，**非传统模型训练**。其优势在于准确度随使用提升（RAG 积累），劣势在于依赖向量数据库和足够的样本积累。

---

**参考来源**

- Pi Agent — 基础 Agent 框架
- extensions.md — 扩展开发文档
- skills.md — Skill 体系文档
- qsv — 快速 CSV 处理 CLI 工具
- DuckDB — 嵌入式分析型数据库
- OpenInterpreter — 本地代码执行代理
- PandasAI — Pandas + LLM 集成
- Vanna AI — RAG-based NL2SQL 工具
