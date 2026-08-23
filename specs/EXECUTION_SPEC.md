# Pi Data Agent — 执行 Spec

> 从架构设计文档提取的落地执行指南。面向开发者（我自己），精确到可直接编码。
> 版本：v1.0 | 基于架构文档 v2.0

---

## 目录

1. [项目结构](#1-项目结构)
2. [依赖清单](#2-依赖清单)
3. [MVP 范围边界](#3-mvp-范围边界)
4. [模块 Spec](#4-模块-spec)
   - 4.1 [安全层](#41-安全层)
   - 4.2 [DuckDB 引擎](#42-duckdb-引擎)
   - 4.3 [工具集](#43-工具集)
   - 4.4 [数据字典懒加载 Hook](#44-数据字典懒加载-hook)
   - 4.5 [查询记忆](#45-查询记忆)
   - 4.6 [错误自修复](#46-错误自修复)
   - 4.7 [Skill 体系](#47-skill-体系)
5. [数据流与交互](#5-数据流与交互)
6. [验收标准](#6-验收标准)
7. [路线图](#7-路线图)

---

## 1. 项目结构

```
pi-data-agent/
├── src/
│   ├── index.ts                    # 扩展入口
│   ├── security.ts                 # 安全层
│   ├── error-recovery.ts           # 错误自修复
│   ├── config.ts                   # 配置管理
│   ├── types.ts                    # 类型定义
│   ├── tools/
│   │   ├── load-data.ts            # P0
│   │   ├── connect-database.ts     # P0
│   │   ├── describe-data.ts        # P0
│   │   ├── query-data.ts           # P0
│   │   ├── transform-data.ts       # P0
│   │   ├── visualize.ts            # P0
│   │   ├── show-image.ts           # P0
│   │   ├── export-result.ts        # P0
│   │   └── list-datasets.ts        # P0
│   ├── hooks/
│   │   ├── data-dictionary.ts      # P0
│   │   └── query-memory.ts         # P0
│   └── engine/
│       └── duckdb.ts               # P0
├── skills/
│   └── data-exploration/
│       ├── SKILL.md
│       └── scripts/
│           └── overview.sql
├── eval/
│   └── regression.test.ts          # MVP 末期
├── package.json
├── tsconfig.json
└── README.md
```

**关键约定：**
- 所有工具文件放在 `src/tools/`，每个工具一个文件
- 所有 Hook 放在 `src/hooks/`
- Skill 按目录组织，每个 Skill 一个文件夹：`SKILL.md` + `scripts/`
- 无 `python/` 目录 — Python 仅在 visualize 工具中无状态调用

---

## 2. 依赖清单

### 2.1 Node.js 依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| `@earendil-works/pi-coding-agent` | latest | Extension API |
| `@duckdb/node-api` | ^1.0.0 | DuckDB 嵌入式引擎 |
| `typebox` | ^0.33.0 | 工具参数 Schema |

### 2.2 系统依赖

| 工具 | 用途 |
|------|------|
| `duckdb` CLI | 大数据文件快速处理（可选，qsv 优先） |
| `qsv` | CSV 快速统计、筛选 |
| Python 3.10+ | visualize 工具调用 matplotlib/seaborn |
| `matplotlib`, `seaborn` | Python 图表生成 |

### 2.3 安装命令

```bash
# Node 依赖
npm install @earendil-works/pi-coding-agent @duckdb/node-api

# 系统工具
brew install duckdb                    # macOS
pip install matplotlib seaborn         # Python 图表
# qsv 安装见 https://github.com/dathere/qsv
```

---

## 3. MVP 范围边界

### 3.1 包含（Must Have）

- 9 个工具（load_data 到 list_datasets）
- 安全层：路径白名单 + 危险动作黑名单 + 读写确认
- DuckDB 嵌入式引擎（单引擎）
- 数据字典懒加载（首次用表触发）
- 查询记忆：容量闸 + 相关性闸（两道闸，MVP）
- 错误自修复闭环（3 次重试）
- 1 个 Skill：data-exploration
- 大结果防撑爆（摘要 + 元数据 + 落盘引用）

### 3.2 不包含（Won't Have in MVP）

| 功能 | 推迟到 |
|------|--------|
| 过时闸（schema 指纹 + 语义过时） | v0.2 |
| 失败查询入库 | v0.2 |
| 冷历史按需召回（embedding） | v0.2 |
| 数据清洗 / 统计分析 / 可视化 / 数据库分析 Skill | v0.2-v0.3 |
| PII 脱敏 | v0.2 |
| 本地模型支持（Ollama） | v0.3+ |
| 心跳/replay log | v0.2 |
| 容器隔离 | v0.4+ |
| ML Skill | v0.4+（拆细粒度） |
| 交互式图表（HTML） | v0.4+ |

---

## 4. 模块 Spec

### 4.1 安全层

**文件：** `src/security.ts`

**接口：**

```typescript
export interface SecurityConfig {
  cwd: string;                    // 工作目录，所有文件操作限定在此
  allowedPaths?: string[];        // 额外允许的路径（如 ~/.pi/agent）
  autoConfirmWrite?: boolean;     // 是否自动确认写操作（默认 false）
}

export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;                // 拦截原因
  requiresConfirm?: boolean;      // 是否需要用户确认
  confirmMessage?: string;        // 确认提示文案
}

export function securityCheck(
  action: string,
  params: Record<string, any>,
  config: SecurityConfig
): SecurityCheckResult;
```

**规则实现：**

#### 4.1.1 路径白名单

```typescript
function isWithinCwd(filePath: string, cwd: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedCwd = path.resolve(cwd);
  return resolved.startsWith(resolvedCwd + path.sep) || resolved === resolvedCwd;
}
```

- 所有 `file_path` 参数必须经过 `isWithinCwd` 检查
- 数据库连接字符串中的路径同样检查
- 越界时返回 `requiresConfirm: true`，由 `ctx.ui.confirm()` 二次确认

#### 4.1.2 危险动作黑名单

| 危险类别 | 检测模式 | 处理方式 |
|----------|----------|----------|
| 文件删除 | `rm`, `rmdir`, `shutil.rmtree`, `os.remove` | 拦截 + 确认 |
| 数据库破坏 | `DROP TABLE`, `DELETE` 无 WHERE | 拦截 + 确认 |
| 系统命令 | `os.system`, `subprocess.call`, `exec` | 拦截 + 确认 |
| 网络请求 | `requests.get`, `urllib`, `fetch` | 拦截 + 确认 |
| 敏感路径 | `~/.ssh`, `~/.pi/agent` 配置目录 | 拦截 + 确认 |

检测方式：正则匹配 SQL/代码字符串，不执行后拦截。

#### 4.1.3 读写确认门控

| 操作类型 | 默认行为 | 可配置 |
|----------|----------|--------|
| 读（SELECT, DESCRIBE, load） | 放行 | 否 |
| 写（INSERT, UPDATE, CREATE, export） | 需确认 | 是（autoConfirmWrite） |
| 删改（DELETE, DROP, 覆盖文件） | 强制确认 | 否（不可关闭） |

**使用位置：** 每个工具的 `execute` 函数入口：

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const security = securityCheck('query_data', params, { cwd: ctx.cwd });
  if (!security.allowed) {
    if (security.requiresConfirm) {
      const confirmed = await ctx.ui.confirm(security.confirmMessage!);
      if (!confirmed) return { content: [{ type: 'text', text: '用户取消操作' }] };
    } else {
      return { content: [{ type: 'text', text: `安全拦截: ${security.reason}` }] };
    }
  }
  // ... 继续执行
}
```

---

### 4.2 DuckDB 引擎

**文件：** `src/engine/duckdb.ts`

**核心设计：**
- 使用 `@duckdb/node-api` 在扩展进程内直接调用
- 数据持久化到 `.pi-data-agent/session.duckdb`
- WAL 保证事务安全
- 进程崩溃后自动恢复（重新连接 .duckdb 文件）

**接口：**

```typescript
export class DuckDBEngine {
  private db: DuckDBInstance | null = null;
  private dbPath: string;

  constructor(projectPath: string) {
    this.dbPath = path.join(projectPath, '.pi-data-agent', 'session.duckdb');
  }

  async init(): Promise<void>;
  async query(sql: string): Promise<QueryResult>;
  async exec(sql: string): Promise<void>;           // 无返回的 DDL/DML
  async close(): Promise<void>;

  // 元数据
  async getTables(): Promise<string[]>;
  async getSchema(tableName: string): Promise<ColumnInfo[]>;
  async getSample(tableName: string, limit: number): Promise<Row[]>;
}

export interface QueryResult {
  columns: string[];
  rows: any[];
  rowCount: number;
  // 大结果：只返回前 N 行 + 总行数
  totalRows?: number;
  resultPath?: string;  // 完整结果落盘路径
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}
```

**大结果处理：**

```typescript
async function executeQueryWithLimit(
  engine: DuckDBEngine,
  sql: string,
  previewLimit: number = 100
): Promise<QueryResult> {
  // 1. 获取总行数
  const countResult = await engine.query(`SELECT COUNT(*) FROM (${sql}) AS t`);
  const totalRows = countResult.rows[0][0];

  // 2. 获取预览行
  const previewSql = `${sql} LIMIT ${previewLimit}`;
  const preview = await engine.query(previewSql);

  // 3. 如果结果大，落盘到文件
  let resultPath: string | undefined;
  if (totalRows > previewLimit) {
    resultPath = path.join(os.tmpdir(), `result_${Date.now()}.csv`);
    await engine.exec(`COPY (${sql}) TO '${resultPath}' (HEADER, DELIMITER ',')`);
  }

  return {
    columns: preview.columns,
    rows: preview.rows,
    rowCount: preview.rows.length,
    totalRows,
    resultPath,
  };
}
```

**返回给 LLM 的格式：**

```typescript
{
  content: [{
    type: 'text',
    text: `查询结果预览（前 ${result.rowCount} / ${result.totalRows} 行）：\n` +
          formatTable(result.columns, result.rows) +
          (result.resultPath ? `\n完整结果已导出: ${result.resultPath}` : '')
  }],
  details: {
    totalRows: result.totalRows,
    resultPath: result.resultPath,
    columns: result.columns,
  }
}
```

---

### 4.3 工具集

#### 4.3.1 工具注册模式

```typescript
// src/index.ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export default function (pi: ExtensionAPI) {
  // 初始化引擎
  const engine = new DuckDBEngine(process.cwd());

  pi.on('session_start', async () => {
    await engine.init();
  });

  pi.on('session_shutdown', async () => {
    await engine.close();
  });

  // 注册工具
  pi.registerTool({
    name: 'load_data',
    label: '加载数据文件',
    description: '将 CSV/Excel/JSON/Parquet 文件加载到 DuckDB',
    parameters: Type.Object({
      file_path: Type.String({ description: '文件路径' }),
      format: Type.Optional(Type.Enum({ csv: 'csv', excel: 'excel', json: 'json', parquet: 'parquet' })),
      table_name: Type.Optional(Type.String({ description: '自定义表名' })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // 安全层检查
      // DuckDB 读取文件
      // 返回表概览
    },
  });

  // ... 其他 8 个工具
}
```

#### 4.3.2 各工具 Spec

**load_data**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file_path | string | 是 | 本地文件路径 |
| format | enum | 否 | 自动检测 |
| table_name | string | 否 | 默认文件名 |

- 安全层检查路径白名单
- DuckDB `CREATE TABLE ... AS SELECT * FROM read_csv_auto('file_path')`
- 返回：表名、行数、列数、列类型概览

**connect_database**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| db_type | enum | 是 | sqlite / duckdb / postgres / mysql |
| connection_string | string | 是 | 连接字符串 |

- DuckDB `ATTACH 'connection_string' AS db_name (TYPE db_type)`
- 返回：连接成功 + schema 列表

**describe_data**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| table_name | string | 是 | 表名 |

- `DESCRIBE table_name` + `SUMMARIZE table_name`
- 返回：列统计（类型、null 比例、唯一值、分布）

**query_data**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sql | string | 是 | SQL 语句 |
| table_name | string | 否 | 上下文表名（用于记忆匹配） |

- 安全层检查：危险动作黑名单（DROP/DELETE 无 WHERE）
- 大结果处理：预览 + 落盘
- 返回：预览结果 + 总行数 + 落盘路径

**transform_data**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sql | string | 是 | CREATE TABLE / INSERT / UPDATE 等 |
| output_table | string | 否 | 输出表名 |

- 写操作需确认
- 返回：影响行数 + 新表概览

**visualize**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| table_name | string | 是 | 数据来源表 |
| chart_type | enum | 是 | histogram / bar / line / scatter / box / heatmap |
| columns | string[] | 是 | 使用的列 |
| title | string | 否 | 图表标题 |

- 流程：DuckDB 查询数据 → 写入临时 CSV → Python 脚本读取 → matplotlib 生成 PNG
- Python 脚本模板：

```python
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
import sys

def generate_chart(data_path, chart_type, columns, output_path, title):
    df = pd.read_csv(data_path)
    plt.figure(figsize=(10, 6))

    if chart_type == 'histogram':
        sns.histplot(data=df, x=columns[0])
    elif chart_type == 'bar':
        sns.barplot(data=df, x=columns[0], y=columns[1])
    # ... 其他类型

    plt.title(title)
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close()

if __name__ == '__main__':
    generate_chart(sys.argv[1], sys.argv[2], sys.argv[3].split(','), sys.argv[4], sys.argv[5])
```

- 返回：PNG 文件路径

**show_image**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image_path | string | 是 | PNG 文件路径 |

- 调用 Pi TUI Image 组件显示
- 返回：显示成功/失败

**export_result**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| table_name | string | 是 | 要导出的表 |
| format | enum | 是 | csv / json / parquet |
| file_path | string | 是 | 输出路径 |

- 写操作需确认
- DuckDB `COPY (SELECT * FROM table) TO 'file_path' (FORMAT ...)`
- 返回：导出成功 + 文件路径

**list_datasets**

- 无参数
- 返回：当前 session 中所有已加载的表名、来源、行数

---

### 4.4 数据字典懒加载 Hook

**文件：** `src/hooks/data-dictionary.ts`

**触发时机：** `query_data` / `describe_data` / `transform_data` 执行前，检查目标表是否已有字典。

**流程：**

```
用户请求: "查询最近7天订单量"
  ↓
query_data 工具被调用，参数 table_name="orders"
  ↓
Hook 检查: orders 是否在字典缓存中？
  ├─ 是 → 继续执行查询
  └─ 否 → 触发字典生成:
      1. 获取 orders schema（DESCRIBE orders）
      2. 获取样本数据（SELECT * FROM orders LIMIT 5）
      3. 调用 LLM 生成字典 JSON
      4. ctx.ui.confirm() 展示字典，等待用户确认/修改
      5. 用户确认后，标记字段为 "validated"
      6. pi.appendEntry("data-dictionary", { table: "orders", dictionary: dict })
      7. 继续执行原查询
```

**字典格式：**

```typescript
interface DataDictionary {
  tableName: string;
  generatedAt: string;
  columns: Array<{
    name: string;
    type: string;
    description: string;        // LLM 生成
    businessMeaning?: string;   // 业务含义
    isValidated: boolean;       // 用户是否确认过
    isAIGuessed: boolean;       // 是否 AI 猜测（未确认=true）
    sampleValues: any[];        // 样本值
  }>;
  aiNotes: string;              // LLM 对表的整体说明
}
```

**恢复：** `session_start` 时从 `sessionManager.getEntries()` 读取所有 `customType === "data-dictionary"` 的 entry，重建缓存。

---

### 4.5 查询记忆

**文件：** `src/hooks/query-memory.ts`

**MVP 范围：** 仅实现容量闸 + 相关性闸。过时闸推迟到 v0.2。

**数据结构：**

```typescript
interface QueryMemoryEntry {
  sql: string;
  naturalLanguage: string;      // 用户的自然语言描述
  datasetFingerprint: string;   // 数据集指纹（表名+schema hash）
  useCount: number;             // 使用频次
  lastUsedAt: number;           // 最近使用时间戳
  relevanceScore: number;       // 相关性加权分
  createdAt: number;
  // v0.2 扩展:
  // schemaFingerprint: string;
  // status: 'success' | 'failed' | 'outdated';
}

interface QueryMemory {
  entries: QueryMemoryEntry[];
  maxEntries: number;           // 默认 5
}
```

**容量闸 — 加权淘汰公式：**

```typescript
function calculateScore(entry: QueryMemoryEntry, now: number): number {
  const frequency = Math.log(entry.useCount + 1);     // 频次对数衰减
  const recency = Math.exp(-(now - entry.lastUsedAt) / (7 * 24 * 3600 * 1000)); // 7天半衰期
  const relevance = entry.relevanceScore;               // 0-1，由数据集匹配度决定
  return frequency * recency * relevance;
}

function evictIfNeeded(memory: QueryMemory, now: number): void {
  if (memory.entries.length <= memory.maxEntries) return;

  // 按分数排序，淘汰最低分
  memory.entries.sort((a, b) => calculateScore(a, now) - calculateScore(b, now));
  memory.entries = memory.entries.slice(-memory.maxEntries);
}
```

**相关性闸：**

```typescript
function generateDatasetFingerprint(tableNames: string[], schema: ColumnInfo[]): string {
  const schemaStr = schema.map(c => `${c.name}:${c.type}`).join(',');
  return hashString(tableNames.sort().join(',') + '|' + schemaStr);
}

function isRelevant(entry: QueryMemoryEntry, currentFingerprint: string): boolean {
  return entry.datasetFingerprint === currentFingerprint;
}
```

**注入时机：** `before_agent_start` 事件，将相关的高分查询注入 system prompt：

```typescript
pi.on('before_agent_start', async (event, ctx) => {
  const currentTables = await engine.getTables();
  const currentSchema = await Promise.all(
    currentTables.map(t => engine.getSchema(t))
  );
  const fingerprint = generateDatasetFingerprint(currentTables, currentSchema.flat());

  const relevantQueries = memory.entries
    .filter(e => isRelevant(e, fingerprint))
    .sort((a, b) => calculateScore(b, Date.now()) - calculateScore(a, Date.now()))
    .slice(0, 3);  // 最多注入 3 条

  if (relevantQueries.length > 0) {
    return {
      systemPromptAppend: `\n\n[历史查询参考]\n` +
        relevantQueries.map(q => `- "${q.naturalLanguage}" → ${q.sql}`).join('\n')
    };
  }
});
```

**入库规则（MVP）：**
- 只存**成功执行**的查询
- 每次 query_data 成功后，检查是否已存在相同 SQL
  - 存在 → useCount++, lastUsedAt = now
  - 不存在 → 新建 entry，计算 relevanceScore
- 然后触发 evictIfNeeded

**持久化：** `pi.appendEntry("query-memory", memory)` + tool result `details` 字段双重保险。

---

### 4.6 错误自修复

**文件：** `src/error-recovery.ts`

**接口：**

```typescript
export interface ErrorRecoveryConfig {
  maxRetries: number;           // 默认 3
  sameErrorThreshold: number;   // 连续相同错误次数上限，默认 3
}

export interface ToolExecutionResult {
  success: boolean;
  result?: ToolResult;
  error?: string;
  attempts: number;
  lastError?: string;
}

export async function executeWithRecovery(
  executeFn: () => Promise<ToolResult>,
  config: ErrorRecoveryConfig,
  onUpdate?: UpdateHandler
): Promise<ToolExecutionResult>;
```

**实现：**

```typescript
export async function executeWithRecovery(
  executeFn: () => Promise<ToolResult>,
  config: ErrorRecoveryConfig = { maxRetries: 3, sameErrorThreshold: 3 },
  onUpdate?: UpdateHandler
): Promise<ToolExecutionResult> {
  let lastError = '';
  let sameErrorCount = 0;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      onUpdate?.({ type: 'text', text: `执行中... (尝试 ${attempt}/${config.maxRetries})` });
      const result = await executeFn();
      return { success: true, result, attempts: attempt };
    } catch (error) {
      const errorMessage = extractErrorDetails(error);
      onUpdate?.({ type: 'text', text: `尝试 ${attempt} 失败: ${errorMessage}` });

      // 检测连续相同错误
      if (errorMessage === lastError) {
        sameErrorCount++;
        if (sameErrorCount >= config.sameErrorThreshold) {
          return {
            success: false,
            error: `连续 ${sameErrorCount} 次相同错误，停止重试。最后错误: ${errorMessage}`,
            attempts: attempt,
            lastError: errorMessage,
          };
        }
      } else {
        sameErrorCount = 1;
        lastError = errorMessage;
      }

      // 如果不是最后一次尝试，将错误作为 tool result 返回给 LLM
      if (attempt < config.maxRetries) {
        return {
          success: false,
          error: errorMessage,
          attempts: attempt,
          lastError: errorMessage,
        };
      }
    }
  }

  return {
    success: false,
    error: `连续 ${config.maxRetries} 次执行失败，最后错误: ${lastError}`,
    attempts: config.maxRetries,
    lastError,
  };
}

function extractErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    return `${error.message}\n${error.stack || ''}`;
  }
  return String(error);
}
```

**使用方式：** 每个执行类工具的 `execute` 函数包装：

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const recovery = await executeWithRecovery(
    async () => {
      // 实际执行逻辑
      return await engine.query(params.sql);
    },
    { maxRetries: 3, sameErrorThreshold: 3 },
    onUpdate
  );

  if (!recovery.success) {
    return {
      content: [{ type: 'text', text: recovery.error! }],
      details: { error: recovery.lastError, attempts: recovery.attempts },
    };
  }

  return recovery.result!;
}
```

**关键规则：**
- 最大重试 3 次
- 连续 3 次相同错误立即停止
- 每次重试对用户可见（onUpdate）
- 错误信息包含：栈 + SQL/代码 + 数据上下文

---

### 4.7 Skill 体系

**MVP 只实现 1 个 Skill：** `data-exploration`

**目录结构：**

```
skills/data-exploration/
├── SKILL.md
└── scripts/
    └── overview.sql
```

**SKILL.md 格式：**

```markdown
---
name: data-exploration
description: Systematic data exploration workflow for understanding datasets
---

# Data Exploration Strategy

## Phase 1: Overview
Run `DESCRIBE` and `SUMMARIZE` on the table.

```sql
-- scripts/overview.sql
DESCRIBE {{table_name}};
SUMMARIZE {{table_name}};
SELECT COUNT(*) AS total_rows FROM {{table_name}};
```

## Phase 2: Distribution Analysis
...

## Active Questioning
Before executing, ask the user:
1. "Are there any known data quality issues?"
2. "What is the business definition of [key metric]?"
```

**获取策略：**

| 策略 | 流程 |
|------|------|
| 现成用 | 直接使用，无需修改 |
| 下载改造 | 审源码（检查联网/依赖/危险操作）→ 适配 DuckDB + 安全层 → fork 修改 |
| 自己做 | 从零编写，遵循 agentskills.io 格式 |

**安全审查清单（下载改造时必须）：**
- [ ] 脚本中无网络请求（`http`, `fetch`, `curl`）
- [ ] 无文件系统操作超出工作目录
- [ ] 无 `os.system` / `exec` / `eval`
- [ ] SQL 无 `DROP` / `DELETE` 无 WHERE
- [ ] 依赖的第三方包已审查

---

## 5. 数据流与交互

### 5.1 典型交互：加载 CSV → 探索 → 查询

```
用户: "帮我分析一下 sales.csv"
  ↓
Agent → load_data(file_path="sales.csv")
  ↓
DuckDB: CREATE TABLE sales AS SELECT * FROM read_csv_auto('sales.csv')
  ↓
返回: "已加载 sales 表，共 10,000 行，12 列"
  ↓
Agent（Skill 触发）→ describe_data(table_name="sales")
  ↓
返回统计摘要
  ↓
Agent: "数据已加载。我注意到 revenue 列有 5% 的缺失值，
        且最大值为 999,999（可能是异常值）。
        您想先处理缺失值，还是直接看整体趋势？"
  ↓
用户: "直接看按月销售额趋势"
  ↓
Agent → query_data(sql="SELECT DATE_TRUNC('month', date) AS month, SUM(revenue) FROM sales GROUP BY month ORDER BY month")
  ↓
返回: 预览结果（前 100 行）+ 总行数 + 落盘路径
  ↓
Agent → visualize(chart_type="line", columns=["month", "sum(revenue)"])
  ↓
Python 生成 PNG → show_image 显示
  ↓
Agent: "这是按月销售额趋势图。3 月和 8 月有明显峰值，
        是否需要进一步分析这两个月份？"
```

### 5.2 数据字典懒加载交互

```
用户: "查询最近7天订单量"
  ↓
query_data 被调用，table_name="orders"
  ↓
Hook: orders 字典不存在？
  ↓
获取 schema + 样本 → 调用 LLM 生成字典
  ↓
ctx.ui.confirm() 展示:
  ┌─────────────────────────────────────┐
  │ 数据字典（AI 生成，请确认/修正）      │
  │                                     │
  │ orders 表                           │
  │ ─────────────────────────────────── │
  │ order_id     BIGINT    订单唯一ID   │
  │ user_id      BIGINT    用户ID      │
  │ amount       DECIMAL   订单金额    │
  │ status       VARCHAR   订单状态    │
  │ created_at   TIMESTAMP 创建时间    │
  │                                     │
  │ [确认]  [修改]                      │
  └─────────────────────────────────────┘
  ↓
用户确认 → 标记 validated → 写入 session
  ↓
继续执行查询
```

---

## 6. 验收标准

### 6.1 功能验收

| # | 验收项 | 通过标准 |
|---|--------|----------|
| 1 | load_data | 能加载 CSV/JSON/Parquet，返回正确行数/列数 |
| 2 | describe_data | DESCRIBE + SUMMARIZE 返回完整统计 |
| 3 | query_data | SQL 执行正确，大结果自动预览+落盘 |
| 4 | visualize | 生成 PNG，终端正确显示 |
| 5 | export_result | 导出 CSV/JSON，文件内容正确 |
| 6 | 安全层 | 越界路径被拦截，危险操作需确认 |
| 7 | 数据字典 | 首次用表触发，用户确认后持久化 |
| 8 | 查询记忆 | 成功查询自动记忆，相关查询注入上下文 |
| 9 | 错误自修复 | 错误触发 LLM 重试，3 次失败停止 |

### 6.2 金标准任务（Eval）

MVP 末期跑以下 3-5 个任务：

| 任务 | 数据集 | 问题 | 预期 |
|------|--------|------|------|
| T1 | iris.csv | "统计各品种的数量" | SQL 正确，数值正确 |
| T2 | 电商订单 | "最近7天的新用户订单量" | SQL 含正确 WHERE，Agent 可能反问"新用户定义" |
| T3 | 销售数据 | "找出销售额异常高的日期" | 正确的异常日期 |
| T4 | 用户数据 | "展示年龄分布" | 推荐 histogram |
| T5 | 含歧义字段 | "分析活跃用户" | Agent 主动反问"活跃的定义" |

**回归测试：** 每次改 prompt/Skill/工具后重跑，对比结果。

---

## 7. 路线图

### Phase 1: MVP（2-3 周）

**目标：** 可运行的数据分析 Agent

**交付：**
- [ ] 项目脚手架（TypeScript + DuckDB + Pi Extension）
- [ ] 安全层（security.ts）
- [ ] DuckDB 引擎（engine/duckdb.ts）
- [ ] 9 个工具（tools/）
- [ ] 数据字典懒加载 Hook
- [ ] 查询记忆（容量闸 + 相关性闸）
- [ ] 错误自修复闭环
- [ ] data-exploration Skill
- [ ] 金标准任务 + 回归测试

### Phase 2: v0.2（1-2 周）

- [ ] 过时闸（schema 指纹 + 语义过时）
- [ ] 失败查询入库
- [ ] 冷历史按需召回（embedding）
- [ ] PII 脱敏
- [ ] 4 个新 Skill
- [ ] 心跳/replay log

### Phase 3: v0.3（2 周）

- [ ] 数据库连接增强（PostgreSQL/MySQL）
- [ ] 统计分析 Skill
- [ ] 可视化 Skill
- [ ] 数据库分析 Skill
- [ ] Eval 体系完善

### Phase 4: v0.4+（按需）

- [ ] ML Skill（细粒度拆分）
- [ ] 本地模型支持（Ollama）
- [ ] 容器隔离
- [ ] 交互式图表
- [ ] 插件市场

---

*End of Spec*
