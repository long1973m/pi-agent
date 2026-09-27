# pi-data-agent 升级方向研究（2026-09）

> 性质：头脑风暴 / 方向探索，非执行 spec。结论供 v0.13+ 规划讨论用。
> 信息来源：代码盘点（v0.12 收口后状态）+ 业界调研（2025–2026 AI 数据分析产品与论文）+ BACKLOG 欠账核对。

---

## 1. 现状定位

v0.12 收口后，项目已具备的能力远超"chat-to-SQL 玩具"：

| 资产 | 现状 |
|---|---|
| 工具面 | 14 个工具（load/query/transform/visualize/report/连接/字典确认/表卡片等） |
| 语义底座 | 数据字典（ai-guessed → user-confirmed 状态机）、表卡片（schema 指纹 + 过期标记）、指标定义库（metrics.json）、口径沉淀（query-memory + recentCalibers） |
| 分析质量 | 证据门（证据不足拒绝编造）+ 质量门（数字溯源/结论覆盖/限制保留）的正式报告管线 |
| 交互面 | 本地 Express Dashboard（字典修正、指标 CRUD、表卡片草稿、上传、SQL 历史） |
| 数据接入 | 本地文件（CSV/TSV/Parquet/JSON/Excel）→ DuckDB；MySQL 只读 ATTACH（真机验收挂账）；v0.13 远程表物化已 spec 未动工 |
| 安全 | 路径白名单、SQL 黑名单、fail-closed 确认门、远端 host 白名单、PII 掩码、审计日志 |

### 业界研究给核心确认

2025–2026 年 AI 数据分析产品（Databricks Genie、Snowflake Cortex Analyst、Hex、Julius、Zenlytic、Dot、Mixpanel Agent 等）收敛到四件事：

1. **语义层**：LLM 从"猜口径"变成"引用口径"。有论文报告语义层让 text-to-SQL 准确率提升 30+ 个百分点；Vanna（纯 RAG text-to-SQL 路线）据第三方转述已存档，佐证"裸 schema + RAG"不够。
2. **验证闭环**：生成 SQL → 校验/门禁执行 → critic 自查 → 图表必须真实执行（Data-to-Dashboard 论文：洞察越强图表越易错，5 张图错 2 张）。
3. **主动洞察**：定时跑指标 → 书面周报推送（Dot 的核心商业模式），从"人问"走向"它报"。
4. **MCP 互操作**：PostHog 放弃内置 AI 助手、全面转向 MCP（bring-your-own-agent）；DataCharter 模式 = 用 DuckDB 联邦数据源、向外部 Agent 只暴露"PII 掩码的只读查询面"。

**这四件事与本项目已有资产高度重合**：字典/指标/表卡片 ≈ 语义层的地基；质量门管线 ≈ 验证闭环的骨架；Dashboard + 报告库 ≈ 推送面；pii-guard + 安全层 ≈ MCP 只读面的现成零件。**升级主题不是加功能，而是把语义底座从"记录档案"翻转成"驱动分析"。**

---

## 2. 六个候选方向

### 方向 1：语义层驱动化 ⭐ 推荐主线

**做什么**：让字典/指标/口径在 SQL 生成时被自动引用，而不是事后展示。

- 落地 L2 即时注入（v0.10 §9.1 设计已完成、未实施）：`query_data` 时按预算（≤200 token、≤2 张表）自动附上相关表卡片 + 指标口径。
- Query Recipe（BACKLOG v0.7 遗留）：已验证的 Q→SQL 沉淀为 few-shot 样例，检索注入 prompt；从 SQL 历史自动晋升（用户纠正后的修正版尤其值得沉淀）。
- 指标词典补齐"个人版语义层"形态：指标名、SQL 口径、维度、业务备注、时区/去重语义。

**为什么值得**：这是所有后续分析准确率的乘数；业界共识性价比最高的准确率手段。BACKLOG 里三件事拼起来正好是它，属于"已付过设计费"的方向。

### 方向 2：PM 分析模板包 ⭐ PM 价值密度最高（真正的新增方向）

**做什么**：把 PM 高频分析做成参数化"一键技能"，而非每次自由 chat：

- **漏斗分析**（步骤定义 + 时间窗 + 转化率）
- **留存 / cohort 三角**（按周/月分群）
- **A/B 试验解读**：样本量充足性、显著性检验、辛普森悖论提醒（市场稀缺的统计护栏）
- 配套：识别 Amplitude / Mixpanel / PostHog 导出 CSV 的常见格式，导入即分析 = "本地版产品分析平台"，与隐私卖点天然契合。

**为什么值得**：PM 的核心痛点是"排队等数据团队"；模板化把"描述需求 → 等结果"变成"给数据 → 出结论"。BACKLOG 中无对应项，是本次调研发现的真正空隙。**前置依赖方向 6（远程表物化），否则只能分析导出文件。**

### 方向 3：主动洞察（周报 + KPI 异常哨兵）

**做什么**：

- 定时唤醒 → 按指标词典逐项跑数 → LLM 写叙事 → 带日期 markdown/HTML 存档 → Dashboard 查看，支持逐期回看对比（衔接 BACKLOG"多报告对比"）。
- 异常检测从环比/同比 + z-score 起步；**LLM 负责"解释异常"，不负责"检测异常"**——统计负责检测，语言负责诊断。可配阈值与静默期防告警疲劳。

**为什么值得**：业界验证的留存型功能；完全落在现有能力内（BACKLOG"自动周期报告"v0.7 就提过）。

**关键前置问题（设计决策）**：调度运行时——Pi 扩展寄生在会话里，"定时唤醒"需要 headless 入口或外部 cron 触发核心模块，这是本方向唯一真正的架构新题。

### 方向 4：验证闭环（分析可信度做穿）

**做什么**：

- SQL 执行前廉价校验：EXPLAIN / dry-run、结果量级 sanity check（行数、量纲、异常 NULL）。
- rubric critic 一轮自查：口径引用对吗？结论被数据支撑吗？限制保留了吗？不通过自动重试（现有 error-recovery 机制可复用）。
- 图表强制"真实执行 + 产物检查"（非空、坐标轴合理），按数据形态规则化选型，失败换型重试（现有 CSV fallback 的强化版）。

**为什么值得**：质量门管线已是骨架，这是自然延伸；"个人 Agent 反而容易做好统计护栏"是差异化机会。

### 方向 5：MCP 暴露（外部杠杆，小成本大杠杆）

**做什么**：起一个本地 MCP server，把 DuckDB 只读查询面 + 已生成的报告库暴露给 Claude / Cursor 等外部 Agent。

- 采用 DataCharter 模式：PII 掩码 + 只读强制 + 查询留痕——pii-guard、security 层、audit-log 全是现成零件。
- 衔接 BACKLOG"MCP 服务暴露知识库"（v0.10 §9）。

**为什么值得**：PostHog 转向 MCP 的行业信号表明"可被任何 Agent 调用"比"内置聊天"更符合趋势；本地私有数据面是这个项目的差异化信任卖点，MCP 是它的分发渠道。

### 方向 6：欠账清理（方向 2 的地基）

- MySQL 真机验收（§12 清单挂账中）。
- v0.13 远程表物化（已 spec 未动工）：`materialize_remote_table` + 大表熔断 + 物化后自动字典/表卡片。
- 顺手：ECharts CDN 硬编码本地化（`echarts-template.ts:207`）。

**为什么值得**：对公司库做模板分析、周报，前提是远程数据能进来且成为一等公民数据集。这是最长欠账，也是其他方向的依赖。

---

## 3. 对齐检查：与 BACKLOG 的关系

| 本次方向 | BACKLOG 对应项 | 性质 |
|---|---|---|
| 方向 1 语义驱动 | L2 即时注入（设计完成）、Query Recipe、SQL 历史晋升、冷历史 embedding 召回 | 已有欠账，设计费已付 |
| 方向 2 PM 模板包 | 无对应 | **真正新增** |
| 方向 3 主动洞察 | 自动周期报告、多报告对比 | 已有欠账，缺运行时设计 |
| 方向 4 验证闭环 | 无直接对应（质量门是相关资产） | 半新增 |
| 方向 5 MCP | MCP 服务暴露知识库 | 已有欠账 |
| 方向 6 欠账清理 | MySQL 验收、v0.13 物化、ECharts 本地化 | 既有计划 |

---

## 4. 推荐路线（供讨论）

1. **先还债**：MySQL 真机验收 + v0.13 物化（方向 6）——不还债，方向 2/3 对真实工作数据的想象都落不了地。
2. **主攻版本主题（如 v0.14"可信分析官"）**：方向 1 + 2 合并——语义层驱动化打底，PM 模板包做拳头功能。
3. **其后**：方向 3 主动洞察（先解决调度运行时）；方向 5 MCP 可穿插（成本小，随时可做）；方向 4 验证闭环可拆散揉进 1/2 的交付里。

## 5. 待用户拍板的问题

1. **数据现实**：PM 工作中的真实数据形态是什么？（公司 MySQL 可否接入 / 主要是导出的 CSV / 产品分析平台导出文件）——直接决定方向 2、3 的真实价值与优先级。
2. **版本主题选择**：三个候选主题——"可信分析官"（1+2+4）、"主动洞察"（3）、"连接与杠杆"（5+6）——先做哪个。
3. **调度环境**：周报类功能需要定时唤醒，使用习惯是常驻 Pi 会话还是按需启动？能否接受系统 cron 触发？

---

## 附：调研来源（节选）

- 产品格局：Querio text-to-SQL 排名 · Mitzu 分析 Agent 指南 · getdot.ai · SiliconAngle（Zenlytic A 轮）· joute.io（Julius）
- 准确率技术：Frontiers 2026（语义层 +33pp）· OpenReview 企业级 agentic text-to-SQL · C3 AI Schema Creator · arXiv 列描述增强
- 语义层：upsolve.ai Agentic Analytics · hex.tech 语义模型同步 · getwren.ai（MDL）
- PM 工作流：vantageos.tech（Mixpanel Agent）· composio.dev（PostHog MCP）· mindtheproduct.com · builder.ai2sql.io（PM 十大 SQL 模板）
- Agent 设计模式：anthropic.com（Building Effective Agents）· arXiv 2505.23695（Data-to-Dashboard）· EmergentMind（DataSTORM）
- local-first 生态：github.com/davidgasquez/awesome-duckdb · duckdb.org · DataCharter（MCP + PII 掩码只读面）
- 主动洞察：getdot.ai（自动化业务评审）· arXiv 2602.13807（AnomaMind）· cassidyai.com

> 注：Vanna 仓库存档、PostHog Max AI 下线两条为第三方转述/推断，未从官方一手信源完全证实，仅作趋势参考。
