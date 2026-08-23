# MVP 代码审查报告

> 审查基准：EXECUTION_SPEC.md v1.0 + MVP-IMPLEMENTATION-STEPS.md v1.1
> 审查日期：2026-06-28
> 代码位置：`/Users/mare/pi-agent/pi-data-agent-extension/src/`

---

## 1. 是否符合执行 Spec

### 1.1 功能验收对照（EXECUTION_SPEC.md §6.1）

| # | 验收项 | Spec 要求 | 实现状态 | 判定 |
|---|--------|----------|----------|------|
| 1 | load_data | 加载 CSV/JSON/Parquet，返回正确行数/列数 | `src/tools/load-data.ts` 完整实现，支持 csv/tsv/parquet/json/jsonl/ndjson，自动检测格式 | ✅ 符合 |
| 2 | describe_data | DESCRIBE + SUMMARIZE 返回完整统计 | `src/tools/describe-data.ts` 完整实现，返回列信息 + SUMMARIZE 统计 | ✅ 符合 |
| 3 | query_data | SQL 执行正确，大结果自动预览+落盘 | `src/tools/query-data.ts` 完整实现，`executeQueryWithLimit` 处理大结果 | ✅ 符合 |
| 4 | visualize | 生成 PNG，终端正确显示 | **未实现**。`src/tools/` 目录下不存在 visualize 工具 | ❌ 缺失 |
| 5 | export_result | 导出 CSV/JSON，文件内容正确 | **未实现**。`src/tools/` 目录下不存在 export_result 工具 | ❌ 缺失 |
| 6 | 安全层 | 越界路径被拦截，危险操作需确认 | `src/security.ts` 完整实现，路径白名单 + SQL 黑名单 + 读写门控 | ✅ 符合 |
| 7 | 数据字典 | 首次用表触发，用户确认后持久化 | `src/hooks/data-dictionary.ts` 实现懒加载和持久化，但**缺少用户确认（`ctx.ui.confirm()`）环节**，自动生成标记为 ai-guessed | ⚠️ 部分符合 |
| 8 | 查询记忆 | 成功查询自动记忆，相关查询注入上下文 | `src/hooks/query-memory.ts` 完整实现，容量闸 + 相关性闸，`before_agent_start` 注入 | ✅ 符合 |
| 9 | 错误自修复 | 错误触发 LLM 重试，3 次失败停止 | `src/error-recovery.ts` 完整实现，3 次重试 + 相同错误停止 + 调试上下文 | ✅ 符合 |

**小结**：9 项功能验收中，6 项完全符合，2 项缺失（visualize、export_result），1 项部分符合（数据字典缺用户确认）。

### 1.2 金标准任务对照（EXECUTION_SPEC.md §6.2）

| 任务 | 数据集 | 问题 | 测试覆盖 | 判定 |
|------|--------|------|----------|------|
| T1 | iris.csv | "统计各品种的数量" | `regression.test.ts` [T1][T2][T8] 覆盖加载、查询、数值正确性 | ✅ 覆盖 |
| T2 | 电商订单 | "最近7天的新用户订单量" | 未覆盖 | ❌ 未覆盖 |
| T3 | 销售数据 | "找出销售额异常高的日期" | 未覆盖 | ❌ 未覆盖 |
| T4 | 用户数据 | "展示年龄分布" | visualize 工具缺失，无法执行 | ❌ 阻塞 |
| T5 | 含歧义字段 | "分析活跃用户" | `regression.test.ts` [T5] 覆盖 `detectAmbiguity`，但未在真实交互中验证 | ⚠️ 部分覆盖 |

**小结**：5 个金标准任务中，1 项完全覆盖，1 项部分覆盖，3 项未覆盖（其中 T4 因工具缺失阻塞）。

### 1.3 交付清单对照（EXECUTION_SPEC.md §7 Phase 1）

| 交付项 | 状态 | 说明 |
|--------|------|------|
| 项目脚手架 | ✅ | TypeScript + DuckDB + Pi Extension，编译通过 |
| 安全层（security.ts） | ✅ | 完整实现 |
| DuckDB 引擎（engine/duckdb.ts） | ✅ | 完整实现 |
| 9 个工具（tools/） | ⚠️ | **仅实现 5 个**（load/describe/query/transform/list），缺失 4 个（connect_database/visualize/show_image/export_result） |
| 数据字典懒加载 Hook | ⚠️ | 实现懒加载和持久化，但**缺用户确认环节** |
| 查询记忆（容量闸 + 相关性闸） | ✅ | 完整实现 |
| 错误自修复闭环 | ✅ | 完整实现 |
| data-exploration Skill | ✅ | `skills/data-exploration/SKILL.md` + `scripts/overview.sql` |
| 金标准任务 + 回归测试 | ⚠️ | `regression.test.ts` 34 断言全部通过，但覆盖不完整（缺 T2/T3/T4） |

**关键差异说明**：
- EXECUTION_SPEC.md 要求 9 个工具，MVP-IMPLEMENTATION-STEPS.md 的 Phase 2 只规划了 5 个工具（S2.1-S2.5）。另外 4 个工具（connect_database、visualize、show_image、export_result）在执行步骤文档中**没有对应的实现步骤**，但在高层 Spec 中被列为 MVP 必须交付。
- **建议**：明确剩余 4 个工具是推迟到 v0.2 还是补进当前 MVP。若推迟，需在文档中标注范围变更。

---

## 2. 是否存在架构偏移

| # | 偏移项 | Spec 要求 | 当前实现 | 影响 | 建议 |
|---|--------|----------|----------|------|------|
| 1 | 持久化策略 | `pi.appendEntry("data-dictionary", ...)` + `ctx.sessionManager.getBranch()` | 文件系统 JSON 持久化（`persistence.ts`） | 数据字典和查询记忆不出现在 Pi session entries 中，与 Spec 的持久化策略不同 | 记录为已知偏差，当前实现更可靠 |
| 2 | 数据字典生成 | LLM 推断语义 + `ctx.ui.confirm()` 用户确认 | 列名模式推断（12 种规则）+ **无用户确认** | 字典质量依赖列名规范性，用户无法修正 | MVP 简化可接受，但需标注为技术债 |
| 3 | Hook 事件名 | `beforeToolCall` | `pi.on("tool_call", ...)` | 事件名不同，功能等效 | 文档化对应关系即可 |
| 4 | 查询记忆淘汰公式 | `score = log(useCount+1) × exp(-recency/7天) × relevanceScore` | `score = useCount × (1/(1+daysAgo))` | 公式精度降低，但功能基本正确 | 建议后续对齐 Spec 公式 |
| 5 | 工具数量 | 9 个工具 | 5 个工具 | 功能覆盖度降低 | 需补 4 个工具或明确范围变更 |

**判定**：存在 5 项架构偏移，其中 2 项为设计选择（持久化策略、Hook 事件名），2 项为 MVP 简化（数据字典生成、淘汰公式），1 项为范围缺失（4 个工具）。无破坏性架构偏移。

---

## 3. 是否存在安全风险

| # | 风险项 | 位置 | 状态 | 说明 |
|---|--------|------|------|------|
| 1 | SQL 注入（表名） | `load-data.ts` `describe-data.ts` | **已修复** | Phase 2 修复：使用 `engine.quoteIdentifier()` 对表名做安全引用 |
| 2 | SQL 注入（文件路径） | `load-data.ts` | **已修复** | 单引号转义 `filePath.replace(/'/g, "''")` |
| 3 | 路径遍历 | `security.ts` | **已处理** | `checkPath()` 规范化路径 + 前缀匹配，越界返回 block/confirm |
| 4 | 危险 SQL 执行 | `security.ts` | **已处理** | DROP TABLE / DELETE 无 WHERE / 系统命令 / 网络请求 均拦截 |
| 5 | 读写门控绕过 | `transform-data.ts` | **已处理** | 写操作强制 confirm，`autoConfirmWrite` 配置已生效 |
| 6 | 大结果撑爆上下文 | `engine/duckdb.ts` | **已处理** | `executeQueryWithLimit` 限制预览 100 行，超限落盘 CSV |

**判定**：当前代码无已知安全漏洞。SQL 注入风险已在 Phase 2 修复中关闭。

---

## 4. 是否存在未完成项

### 4.1 工具层（4 个工具缺失）

| 工具 | 文件 | 优先级 | 说明 |
|------|------|--------|------|
| connect_database | `src/tools/connect-database.ts` | P1 | 连接外部数据库（PostgreSQL/MySQL/SQLite），Spec 定义为 P0 |
| visualize | `src/tools/visualize.ts` | P1 | 生成图表（histogram/bar/line/scatter/box/heatmap），Spec 定义为 P0 |
| show_image | `src/tools/show-image.ts` | P2 | 在 TUI 中展示图片，Spec 定义为 P0 |
| export_result | `src/tools/export-result.ts` | P1 | 导出结果到 CSV/JSON/Parquet，Spec 定义为 P0 |

### 4.2 功能层

| 项 | 状态 | 说明 |
|----|------|------|
| 数据字典用户确认 | **未完成** | `ctx.ui.confirm()` 未调用，字典自动生成后无用户确认环节 |
| 查询记忆淘汰公式 | **未对齐** | 当前线性衰减，Spec 要求对数+指数衰减 |
| Python requirements.txt | **缺失** | 无 Python 依赖声明文件 |

### 4.3 测试层

| 项 | 状态 | 说明 |
|----|------|------|
| T2 电商订单场景 | **未覆盖** | 时间范围 + 新用户定义的 SQL 正确性 |
| T3 异常检测场景 | **未覆盖** | 销售额异常日期检测 |
| T4 可视化场景 | **阻塞** | visualize 工具缺失，无法测试 |
| T5 真实交互验证 | **未覆盖** | `detectAmbiguity` 单元测试通过，但未在 Pi CLI 真实对话中验证 |
| 安全层边界测试 | **未覆盖** | 如 `UPDATE` 有 WHERE 时应 confirm 而非 block，当前未测试 |
| 错误自修复测试 | **未覆盖** | 未测试 3 次重试、相同错误停止、调试上下文完整性 |
| 查询记忆集成测试 | **未覆盖** | 未测试 `before_agent_start` 注入的查询是否被 Agent 实际使用 |

---

## 5. 测试是否充分

### 5.1 现有测试覆盖

`src/eval/regression.test.ts`：34 个断言，全部通过。

| 测试组 | 断言数 | 覆盖内容 |
|--------|--------|----------|
| T1 CSV 加载 | 3 | 表名、行数、列数 |
| T2 SQL 查询 | 5 | 分组数、截断状态、品种名包含 |
| T3 大结果处理 | 4 | 截断、预览行数、总行数、CSV 路径 |
| T4 安全拦截 | 4 | DROP TABLE、DELETE 无 WHERE、SELECT 放行、越界路径 |
| T5 主动反问 | 5 | 模糊检测、理由数、选项数、impliedAssumption、明确查询不触发 |
| T6 收敛性 | 2 | 阈值机制存在性 |
| T7 安全层综合 | 8 | SELECT/DESCRIBE 放行、INSERT 需确认、DROP/DELETE 拦截、CTAS 需确认、路径安全 |
| T8 数值正确性 | 3 | setosa/versicolor/virginica 各 10 条 |

### 5.2 测试缺口

| 缺口 | 风险 | 优先级 |
|------|------|--------|
| 无 visualize 工具测试 | T4 金标准任务无法验证 | P1 |
| 无 export_result 工具测试 | 导出功能未验证 | P1 |
| 无 connect_database 工具测试 | 外部数据库连接未验证 | P1 |
| 无错误自修复流程测试 | 重试逻辑、相同错误停止未验证 | P2 |
| 无查询记忆注入效果测试 | 无法验证记忆是否被 Agent 使用 | P2 |
| 无数据字典交互测试 | 无法验证懒加载 Hook 在真实流程中触发 | P2 |
| 无 Pi CLI 集成测试 | 所有测试在模拟环境中运行，未在真实 Pi 环境中验证 | P2 |
| 无回归测试自动化 | 每次改代码后需手动运行 `npx tsx` | P2 |

**判定**：现有测试覆盖了核心功能的基本路径，但**缺少 4 个工具的测试、错误自修复流程测试、以及真实 Pi CLI 集成测试**。测试充分度为 **中等**。

---

## 6. 必须修改项（阻塞项）

以下项必须修复后方可进入下一阶段（v0.2）：

| # | 修改项 | 原因 | 文件 | 工作量 |
|---|--------|------|------|--------|
| 1 | **明确 4 个缺失工具的处理方式** | Spec 要求 9 个工具，当前仅 5 个。需决策：补进 MVP 还是推迟到 v0.2 | — | 文档工作 |
| 2 | **export_result 工具** | P0 功能，数据导出是分析闭环的最后一步 | `src/tools/export-result.ts` | 0.5-1 天 |
| 3 | **connect_database 工具** | P0 功能，外部数据库连接是数据分析的基础能力 | `src/tools/connect-database.ts` | 1 天 |

**说明**：visualize 和 show_image 涉及 Python matplotlib 和 Pi TUI Image 组件，实现复杂度较高，可明确推迟到 v0.2。但 export_result 和 connect_database 是核心功能，建议补进 MVP。

---

## 7. 建议修改项（非阻塞）

| # | 修改项 | 原因 | 文件 | 优先级 |
|---|--------|------|------|--------|
| 1 | 数据字典增加用户确认环节 | Spec 要求 `ctx.ui.confirm()`，当前自动生成无确认 | `src/hooks/data-dictionary.ts` | P1 |
| 2 | 对齐查询记忆淘汰公式 | 当前线性衰减，Spec 要求 `log × exp × relevance` | `src/hooks/query-memory.ts` | P2 |
| 3 | 创建 Python requirements.txt | 锁定 matplotlib/seaborn/pandas/numpy 版本 | `requirements.txt` | P2 |
| 4 | 补充 T2/T3 金标准任务测试 | 电商订单和时间范围查询、异常检测 | `src/eval/regression.test.ts` | P2 |
| 5 | 补充错误自修复流程测试 | 验证重试、相同错误停止、调试上下文 | `src/eval/regression.test.ts` | P2 |
| 6 | `buildCountSql()` 正则优化 | 可能误删子查询 LIMIT | `src/engine/duckdb.ts` | P3 |
| 7 | `UPDATE` 正则意图明确化 | 当前匹配所有 UPDATE，需确认是检测所有 UPDATE 还是仅无 WHERE 的 | `src/security.ts` | P3 |
| 8 | `poc_dummy` 工具改为可选 | 避免 Agent 误用测试工具 | `src/index.ts` | P3 |

---

## 8. 是否允许进入下一阶段

**判定：有条件允许进入 v0.2。**

**条件**：
1. 必须明确 4 个缺失工具的处理方式（补进 MVP 或推迟到 v0.2）
2. 建议至少实现 export_result 工具（数据导出是分析闭环的关键）
3. 数据字典用户确认环节建议补进（影响用户体验）

**若不满足条件**：停留在当前阶段，优先完成必须修改项。

---

## 9. 必须先修的问题清单

### 9.1 进入 v0.2 前的必须修复项

按优先级排序：

1. **文档决策**：在 README 或 Spec 中明确标注 MVP 范围变更（9 个工具 → 5 个工具 + 2 个推迟 + 2 个待定）
2. **export_result 工具**：实现 `export_result` 工具（ DuckDB COPY TO + 安全层检查 + 格式支持 CSV/JSON/Parquet）
3. **connect_database 工具**：实现 `connect_database` 工具（DuckDB ATTACH + 多数据库类型支持）

### 9.2 与 v0.2 并行的建议修复项

4. **数据字典用户确认**：在 `ensureDictionary` 流程中增加 `ctx.ui.confirm()` 调用
5. **补充 T2/T3 测试**：电商订单查询、异常检测场景
6. **补充错误自修复测试**：验证重试逻辑和调试上下文

---

## 附录：代码文件清单

```
src/
├── index.ts                          # Extension 入口（集成所有模块）
├── types.ts                          # 共享类型定义
├── config.ts                         # 配置管理
├── persistence.ts                    # 三层持久化读写
├── security.ts                       # 安全层
├── error-recovery.ts                 # 错误自修复
├── engine/
│   └── duckdb.ts                     # DuckDB 引擎
├── tools/
│   ├── tool-context.ts               # 工具上下文接口
│   ├── load-data.ts                  # ✅ S2.1 加载数据
│   ├── describe-data.ts              # ✅ S2.2 数据描述
│   ├── query-data.ts                 # ✅ S2.3 SQL 查询
│   ├── transform-data.ts             # ✅ S2.4 数据转换
│   ├── list-datasets.ts              # ✅ S2.5 数据集列表
│   └── ask-clarification.ts          # ✅ S3.1 主动反问工具
├── hooks/
│   ├── active-questioning.ts         # ✅ S3.2 主动反问拦截
│   ├── data-dictionary.ts            # ⚠️ S3.3 数据字典（缺用户确认）
│   └── query-memory.ts               # ✅ S3.4 查询记忆
├── utils/
│   ├── dataset-fingerprint.ts        # ✅ S1.6 数据集指纹
│   └── schema-fingerprint.ts         # ✅ S1.7 Schema 指纹
└── eval/
    └── regression.test.ts            # ⚠️ S6.1-S6.4 回归测试（部分覆盖）

skills/
└── data-exploration/
    ├── SKILL.md                      # ✅ S5.1 Skill 文档
    └── scripts/
        └── overview.sql              # ✅ S5.2 SQL 脚本

缺失文件（Spec 要求但未实现）：
- src/tools/connect-database.ts       # ❌ 连接外部数据库
- src/tools/visualize.ts              # ❌ 生成图表
- src/tools/show-image.ts             # ❌ TUI 展示图片
- src/tools/export-result.ts          # ❌ 导出结果
```
