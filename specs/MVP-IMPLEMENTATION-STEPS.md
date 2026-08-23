# Pi Data Agent — MVP 实现步骤清单 (Revised)

> 版本：v1.1 | 基于架构文档 v2.0 + 执行 Spec v1.0 + 评审修订
> 修订日期：2026-06-23
> 参考文档：架构文档 [1]、整改/评审文档 [2][3]

---

## 设计原则

- **风险前置**：先验证 Pi Extension API + DuckDB 能跑通，再搭架子
- **最小闭环优先**：5 个核心工具先打通，剩余 4 个第二批
- **护城河进 MVP**：主动反问（ask_clarification + active-questioning Hook）是差异化核心，不能只靠 Skill 提示词
- **依赖链清晰**：每个步骤标注前置依赖，严格按序执行

---

## Phase 0：核 API + 最小 PoC（1-2 天） ✅ 已完成

> 目标：确认「Pi 扩展机制 + DuckDB」能跑通，不搭架子。

### S0.1 核 Pi Extension API ✅

| 项 | 说明 |
|---|---|
| [x] 验证点 | `pi.registerTool` 注册一个 dummy 工具能被 Agent 调用 |
| [x] 验证点 | `pi.on('session_start')` / `pi.on('session_shutdown')` 生命周期触发 |
| [x] 验证点 | `pi.on('before_agent_start')` 能返回 `systemPromptAppend` |
| [x] 验证点 | `ctx.ui.confirm()` 能阻塞等待用户确认 |
| [x] 验证点 | `ctx.ui.select()` 能展示选项并接收选择（主动反问依赖此能力） |
| [~] 验证点 | `ctx.sessionManager.getBranch()` 能读写 session 数据（代码已补充，TUI 模式待验证） |
| [x] 验证点 | tool result 的 `details` 字段能传递结构化元数据 |
| 产出 | 一个最小 Extension PoC，注册 1 个 dummy 工具，跑通 session 生命周期 |
| 验收 | Pi CLI 加载该 Extension，dummy 工具可被调用，生命周期事件正常触发 |

### S0.2 DuckDB 最小 PoC ✅

| 项 | 说明 |
|---|---|
| [x] 验证点 | `@duckdb/node-api` 在当前 Node 版本下能正常 import |
| [x] 验证点 | 创建 `.pi-data-agent/session.duckdb` 文件 |
| [x] 验证点 | `SELECT 1` 返回正确结果 |
| [x] 验证点 | 加载一个 CSV 文件（如 iris.csv）到 DuckDB |
| [x] 验证点 | 查询前 10 行，返回正确数据 |
| [x] 验证点 | 进程重启后重新连接 .duckdb 文件，数据仍在 |
| 产出 | 独立 PoC 脚本，验证 DuckDB 嵌入式能力 |
| 验收 | CSV 加载、查询、持久化、恢复全通过 |

### S0.3 安装系统依赖 ✅

| 项 | 说明 |
|---|---|
| [x] 依赖 | Python 3.10+、`matplotlib`、`seaborn`、`pandas`、`numpy` |
| [x] 验收 | `python -c "import matplotlib; import seaborn"` 通过 |
| 产出 | `requirements.txt` 锁定版本 |

---

## Phase 1：地基层（2-3 天） ✅ 已完成

> 前置依赖：Phase 0 全部通过

### S1.1 `src/types.ts` — 共享类型定义

| 项 | 说明 |
|---|---|
| [x] 内容 | `QueryResult`、`ColumnInfo`、`SecurityConfig`、`SecurityCheckResult`、`DataDictionary`、`QueryMemoryEntry`、`QueryMemory`、`Clarification`、`ErrorRecoveryConfig`、`ToolExecutionResult` |
| [x] 验收 | TypeScript 编译通过，无 `any` 残留 |

### S1.2 `src/config.ts` — 配置管理

| 项 | 说明 |
|---|---|
| [x] 内容 | cwd、allowedPaths、autoConfirmWrite、maxQueryMemoryEntries、previewLimit 等 |
| [x] 来源 | 环境变量 / 默认值 / 项目级配置文件 |
| [x] 验收 | 配置可加载，默认值合理 |

### S1.3 `src/persistence.ts` — 三层持久化读写

| 项 | 说明 |
|---|---|
| [x] 内容 | Global 层（`~/.config/pi-data-agent/`）、Project 层（`./.pi-data-agent/`）、Session 层（内存） |
| [x] 能力 | 读写 YAML/JSON 配置文件、session 数据恢复 |
| [x] 验收 | 数据字典 / 查询记忆的持久化和恢复可用 |

### S1.4 `src/security.ts` — P0 安全层

| 项 | 说明 |
|---|---|
| [x] 内容 | 路径白名单（`isWithinCwd`）、危险动作黑名单（正则匹配）、读写确认门控 |
| [x] 验收 | 越界路径 → `requiresConfirm`；`DROP TABLE` 无 WHERE → 拦截；读操作放行；删改 → 强制确认 |

### S1.5 `src/engine/duckdb.ts` — DuckDB 引擎

| 项 | 说明 |
|---|---|
| [x] 内容 | `DuckDBEngine` 类：`init`、`query`、`exec`、`close`、`getTables`、`getSchema`、`getSample` |
| [x] 内容 | 大结果处理：`executeQueryWithLimit` — COUNT → 预览 N 行 → 落盘 CSV |
| [x] 内容 | WAL 事务安全 + 崩溃自恢复（重新连接 .duckdb 文件） |
| [x] 验收 | 创建 session.duckdb，执行 `SELECT 1`，查询 1000+ 行数据只返回前 100 行 + 总行数 + 落盘路径 |

### S1.6 `src/utils/dataset-fingerprint.ts` — 数据集指纹

| 项 | 说明 |
|---|---|
| [x] 内容 | `generateDatasetFingerprint(tableNames, schema)` — 表名排序 + schema 字符串 hash |
| [x] 用途 | 查询记忆相关性闸 |
| [x] 验收 | 相同表结构 → 相同指纹；表结构变更 → 指纹不同 |

### S1.7 `src/utils/schema-fingerprint.ts` — Schema 指纹

| 项 | 说明 |
|---|---|
| [x] 内容 | `generateSchemaFingerprint(columns)` — 列名 + 类型 hash |
| [x] 用途 | v0.2 过时闸预留接口，MVP 先实现但暂不使用 |
| [x] 验收 | 列变更后指纹不同 |

---

## Phase 2：最小工具闭环（3-4 天） ✅ 已完成

> 前置依赖：Phase 1 全部通过
> 策略：先做 5 个核心工具，打通「加载 → 看结构 → 查询 → 转换 → 列表」闭环

### S2.1 `src/tools/load-data.ts`

| 项 | 说明 |
|---|---|
| [x] 参数 | `file_path`（必填）、`format`（可选，自动检测）、`table_name`（可选，默认文件名） |
| [x] 逻辑 | 安全层检查路径 → DuckDB `CREATE TABLE AS SELECT * FROM read_csv_auto()` → 返回表概览 |
| [x] 验收 | 加载 iris.csv，返回行数 / 列数 / 列类型 |

### S2.2 `src/tools/describe-data.ts`

| 项 | 说明 |
|---|---|
| [x] 参数 | `table_name`（必填） |
| [x] 逻辑 | `DESCRIBE` + `SUMMARIZE` → 返回列统计（类型、null 比例、唯一值、分布） |
| [x] 验收 | 对已加载表执行，返回完整统计摘要 |

### S2.3 `src/tools/query-data.ts`

| 项 | 说明 |
|---|---|
| [x] 参数 | `sql`（必填）、`table_name`（可选，用于记忆匹配） |
| [x] 逻辑 | 安全层检查（危险 SQL 黑名单）→ 大结果处理 → 返回预览 + 总行数 + 落盘路径 |
| [x] 验收 | 执行 `SELECT COUNT(*) FROM iris`，返回正确数值；大结果自动预览 + 落盘 |

### S2.4 `src/tools/transform-data.ts`

| 项 | 说明 |
|---|---|
| [x] 参数 | `sql`（必填，CTAS / INSERT / UPDATE）、`output_table`（可选） |
| [x] 逻辑 | 写操作需安全层确认 → 执行 → 返回影响行数 + 新表概览 |
| [x] 验收 | 创建新表，返回影响行数 + 新表名 + 列信息 |

### S2.5 `src/tools/list-datasets.ts`

| 项 | 说明 |
|---|---|
| [x] 参数 | 无 |
| [x] 逻辑 | 查询 DuckDB 元数据 → 返回所有已加载表名、来源、行数 |
| [x] 验收 | 返回已加载表列表，信息准确 |

### Phase 2 集成验证

| 项 | 说明 |
|---|---|
| [x] 流程 | `load_data` → `describe_data` → `query_data` → `transform_data` → `list_datasets` |
| [x] 验收 | 用 iris.csv 跑通完整闭环，无报错 |

---

## Phase 3：护城河能力（3-4 天） ✅ 已完成

> 前置依赖：Phase 2 最小闭环通过
> 核心差异化：主动反问不能只靠 Skill 提示词，必须有工具 + Hook 双入口

### S3.1 `src/tools/ask-clarification.ts` — 主动反问工具

| 项 | 说明 |
|---|---|
| [x] 定位 | 交互工具，**不计入 9 个数据工具** |
| [x] 契约 | typed `Clarification`：`question` / `why` / `options[]{ id, label, impliedAssumption }` / `allowFreeText` / `defaultIfSkip` |
| [x] 选项数 | 2-4 个，每个选项自带 `impliedAssumption`（摊口径） |
| [x] defaultIfSkip | 用户说"你定"时自动选默认 + 声明口径，绝不死等 |
| [x] 非交互模式 | `-p` / `--mode json` / RPC / SDK → 走 `defaultIfSkip`，声明所用口径 |
| [x] 验收 | Agent 调用此工具时，TUI 展示结构化选项；用户选择后返回选项 ID |

### S3.2 `src/hooks/active-questioning.ts` — 主动反问拦截 Hook

| 项 | 说明 |
|---|---|
| [x] 触发 | `beforeToolCall` 拦截 `query_data` |
| [x] 逻辑 | 检测口径歧义（模糊关键词、未定义指标、时间范围不明等）→ 不直接执行 SQL → 先触发 `ask_clarification` |
| [x] 不触发 | 意图明确且低风险时直接执行，只亮 SQL + 摊假设，不打断 |
| [x] 验收 | "分析活跃用户" 触发 clarify；"SELECT COUNT(*) FROM iris" 不触发 |

### S3.3 `src/hooks/data-dictionary.ts` — 数据字典懒加载

| 项 | 说明 |
|---|---|
| [x] 触发 | `query_data` / `describe_data` / `transform_data` 执行前 |
| [x] 逻辑 | 检查目标表是否已有字典 → 无则 DESCRIBE + 样本 → LLM 推断语义 → `ctx.ui.confirm()` 展示 → 用户确认/修正 → 标记 `validated` / `AI-guessed` → `pi.appendEntry` 持久化 |
| [x] 恢复 | `session_start` 时从 session 数据重建缓存 |
| [x] 验收 | 首次查询某表时弹出字典确认；二次查询直接复用；确认后标记 `validated` |

### S3.4 `src/hooks/query-memory.ts` — 查询记忆

| 项 | 说明 |
|---|---|
| [x] MVP 范围 | 容量闸 + 相关性闸（过时闸推 v0.2） |
| [x] 容量闸 | 频次 × 新近 × 相关性加权淘汰，保留最多 5 条 |
| [x] 相关性闸 | 数据集指纹匹配，只召回涉及当前数据集的查询 |
| [x] 注入 | `before_agent_start` 事件，最多注入 3 条相关查询到 system prompt |
| [x] 入库 | 只存成功查询；相同 SQL → useCount++；新 SQL → 新建 entry |
| [x] 持久化 | `pi.appendEntry("query-memory", memory)` + tool result `details` 双保险 |
| [x] 验收 | 成功查询入库；超 5 条自动淘汰最低分；相关查询注入上下文；同口径不重复问 |

---

## Phase 4：错误自修复（1-2 天） ✅ 已完成

> 前置依赖：Phase 2 核心工具完成

### S4.1 `src/error-recovery.ts`

| 项 | 说明 |
|---|---|
| [x] 接口 | `executeWithRecovery(executeFn, config, onUpdate)` |
| [x] 规则 | 最大 3 次重试；连续 3 次相同错误立即停止；每次重试 `onUpdate` 通知用户 |
| [x] 最终失败 | 返回完整上下文：SQL + 错误信息 + schema + 样本 + 已尝试修复路径 |
| [x] 禁止 | 未解决的失败不得写入长期记忆 |
| [x] 验收 | 错误 SQL 触发重试；连续 3 次相同错误立即停止；最终失败附完整调试信息 |

### S4.2 包装核心工具

| 项 | 说明 |
|---|---|
| [x] 范围 | `query_data`、`transform_data`、`load_data` 的 execute 函数用 `executeWithRecovery` 包装 |
| [x] 验收 | 工具执行失败时自动重试，对用户可见 |

---

## Phase 5：Skill（1-2 天） ✅ 已完成

> 前置依赖：Phase 3 护城河能力完成
> 策略：MVP 只做 1 个 Skill，先验证机制再铺量

### S5.1 `skills/data-exploration/SKILL.md`

| 项 | 说明 |
|---|---|
| [x] 格式 | YAML frontmatter（name, version, priority, description, tags）+ 策略文字 + 脚本引用 + 主动反问模板 |
| [x] 内容 | Phase 1 概览（DESCRIBE + SUMMARIZE）+ Phase 2 分布分析 + 高频值分析 |
| [x] 主动反问模板 | 结构化选项（分析范围、时间范围等），对齐 `Clarification` 契约 |
| [x] 解释规则 | 「怎么看结果」的说明，帮助用户理解统计输出 |
| [x] 验收 | Skill 被 Agent 正确加载；使用时触发主动反问模板 |

### S5.2 `skills/data-exploration/scripts/overview.sql`

| 项 | 说明 |
|---|---|
| [x] 内容 | DESCRIBE、SUMMARIZE、COUNT(*)、列分布分析、高频值 TOP 20 |
| [x] 占位符 | `{table_name}`、`{column}` 运行时替换 |
| [x] 验收 | SQL 在 DuckDB 中可执行，返回正确结果 |

---

## Phase 6：Eval（1-2 天） ✅ 已完成

> 前置依赖：Phase 5 全部完成

### S6.1 `eval/regression.test.ts` — 金标准任务

| # | 任务 | 数据集 | 问题 | 预期 |
|---|------|--------|------|------|
| [x] T1 | CSV 加载 | iris.csv | 加载数据 | 返回正确行数 / 列数 |
| [x] T2 | SQL 查询 | iris.csv | "统计各品种的数量" | SQL 正确，数值正确 |
| [x] T3 | 大结果 | 大数据集 | 查询全量 | 只返回预览 + 总行数 + 落盘路径，上下文不撑爆 |
| [x] T4 | 安全拦截 | 任意 | `DROP TABLE iris` | 被拦截，需确认 |
| [x] T5 | 主动反问 | 含歧义字段 | "分析活跃用户" | 触发 clarify，断言如下 ↓ |

### S6.2 主动反问专项断言

```typescript
expect(result.sql).toBeNull()                              // 不应直接生成 SQL
expect(result.clarification.options.length).toBeGreaterThanOrEqual(2)  // 至少 2 个选项
expect(option.impliedAssumption).toBeTruthy()              // 每个选项带口径假设
expect(result.clarification.defaultIfSkip).toBeDefined()   // 必须有默认口径
```

### S6.3 收敛性断言

```typescript
// 同口径不重复反问
await agent.query('分析活跃用户', { confirmedScope: 'all' })
const second = await agent.query('再分析活跃用户')
expect(second.clarification).toBeNull()  // 已确认口径，不再弹
```

### S6.4 安全层专项测试

| 测试项 | 预期 |
|--------|------|
| [x] 越界路径访问 | 返回 `requiresConfirm: true` |
| [x] `DROP TABLE` 无 WHERE | 被拦截 |
| [x] `DELETE FROM` 无 WHERE | 被拦截 |
| [x] 读操作（SELECT） | 放行 |
| [x] 写操作（INSERT/CREATE） | 需确认 |
| [x] 删改操作（DELETE/DROP 有 WHERE） | 强制确认 |

---

## 关键路径

```
S0.1 (Pi API) ──→ S0.2 (DuckDB PoC)
                      │
                      ▼
S1.1 (types) → S1.2 (config) → S1.3 (persistence) → S1.4 (security) → S1.5 (duckdb engine)
                                                                        │
                                                                        ▼
                                              S2.1 (load) → S2.2 (describe) → S2.3 (query)
                                                                    │
                                                                    ▼
                                              S3.1 (ask_clarification) ← S3.2 (active-questioning)
                                                    │
                                              S3.3 (data-dictionary) + S3.4 (query-memory)
                                                    │
                                                    ▼
                                              S4.1 (error-recovery) → S4.2 (包装工具)
                                                    │
                                                    ▼
                                              S5.1 (SKILL.md) + S5.2 (overview.sql)
                                                    │
                                                    ▼
                                              S6.1-S6.4 (Eval)
```

**最短关键路径**：S0 → S1 → S2.1-S2.3 → S3.1-S3.2 → S4 → S5 → S6 ≈ **10-12 天**

---

## 第二批工具（MVP 后 / v0.2）

以下工具在 Phase 2 最小闭环验证通过后补充：

| 工具 | 说明 |
|------|------|
| `connect_database` | DuckDB ATTACH 连接外部数据库 |
| `visualize` | DuckDB → CSV → Python matplotlib → PNG |
| `show_image` | TUI 展示图片 |
| `export_result` | DuckDB COPY TO 导出 |

---

## 风险项

| 风险 | 影响 | 缓解 |
|------|------|------|
| `@duckdb/node-api` macOS 兼容性 | 阻塞 Phase 0 | S0.2 最先验证 |
| Pi Extension API 中 `ctx.ui.select()` 是否支持多选项 | 阻塞 S3.1 | S0.1 核 API 时确认 |
| Hook 中能否调用 LLM（数据字典生成） | 阻塞 S3.3 | S0.1 核 API 时确认 |
| Python matplotlib 安装问题 | 阻塞 visualize | 准备 fallback 安装脚本 |
| `pi.appendEntry` 的 customType 是否支持自定义 | 阻塞 S3.3/S3.4 | S0.1 核 API 时确认 |
