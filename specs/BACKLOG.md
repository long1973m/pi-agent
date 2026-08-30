# BACKLOG — 跨版本统一欠账清单

> 建立于 v0.11（B-1 任务，来源：v0.11-EXECUTION_SPEC.md §11.2）。
> 规则：后续所有 Deferred / 推迟项只进本文件，不再散落到各版本 spec。
> 表格列：事项 | 来源版本 | 当前状态 | 备注

## 功能与产品

| 事项 | 来源版本 | 当前状态 | 备注 |
|------|----------|----------|------|
| PostgreSQL / MySQL 连接 | v0.2 §1.3（v0.3 再推） | 未开始 | **v0.2 起最长欠账**。阻塞点：连接串安全、DuckDB 扩展依赖、网络访问 |
| 冷历史 embedding 召回 | v0.2 §1.3（v0.3 再推） | 未开始 | 查询记忆规模未到阈值；建议规模超千条后再评估 |
| 本地模型支持（Ollama） | 初版 EXECUTION_SPEC §推迟表（v0.3+） | 未开始 | LLM 调用已收敛到 llm/call-llm.ts，可在此层扩展 |
| ML Skill（细粒度拆分） | 初版 EXECUTION_SPEC §推迟表（v0.4+）；v0.2 拆为 statistical-analysis / database-analysis Skill | 未开始 | 依赖 Python 环境标准化（见 requirements 版本钉死冲突问题） |
| 交互式 HTML 图表 | v0.2 §1.3 | 部分交付（echarts-template） | 🔴 ECharts CDN 硬编码 `echarts-template.ts:207`，与"离线自包含"交付原则矛盾，需本地化或内联 |
| Query Recipe / 语义查询资产 | v0.7 §Deferred | 未开始 | 需要检索、验证、失效与 Agent 复用全链路 |
| 从 SQL 历史自动晋升查询资产 | v0.7 §Deferred | 未开始 | 依赖 Query Recipe 状态机 |
| 自动周期报告 | v0.7 §Deferred | 未开始 | 需要调度、数据刷新和时间窗口语义 |
| 多报告对比 | v0.6 §Deferred（v0.5 已提"真正的多会话实时对比"） | 未开始 | 需要统一分析产物模型和差异算法 |
| PDF / Excel 导出 | v0.7（打印导出要求）；v0.11 §11.2 | 未开始 | 报告当前为 HTML 单文件；打印样式 v0.7 已预留（无导航/调试控件） |
| 跨会话记忆共享 | v0.11 §11.2 | 未开始 | 当前 query-memory / 口径已按 project 层持久化，缺主动跨会话共享语义 |
| Dashboard 内直接执行任意 SQL | v0.6 §Deferred | 未开始 | 会改变现有安全模型，需单独设计权限与资源限制 |
| Agent 实时思考/工具调用流 | v0.6 §Deferred | 未开始 | 需要 Agent 进程通信或 WebSocket |
| 多用户、账号和远程访问 | v0.6 §Deferred | 未开始 | 当前定位为本地个人工具 |
| 修改 DuckDB 物理 Schema | v0.6 §Deferred | 未开始 | 当前只维护字典元数据 |
| 插件与主题系统 | v0.6 §Deferred | 未开始 | 当前阶段过度工程化 |
| Web UI / 独立客户端 | v0.3 §Deferred | 部分交付（Dashboard） | v0.6-v0.10 已演进为本地 Dashboard；独立客户端仍未开始 |
| 多引擎 Polars | v0.3 §Deferred | 未开始 | DuckDB 足够支撑 |
| 完整 BI dashboard | v0.3 §Deferred | 未开始 | 超出 Agent MVP 边界 |
| 数据字典 LLM 全自动化 | v0.2 §1.3（v0.3 再推） | 部分（confirm-dictionary 手动确认流） | API 能力与隐私边界未完全确认；交互重做见下条 |
| 字典 AI 推断交互重做 | v0.10 §9 | 未开始 | 等用户补充"不好用"的具体表现后再动 |
| 表分类的自动聚类/层级目录 | v0.10 §9 | 未开始 | v0.10 先用 tags，表多了再演进 |
| 视觉整体翻新（卡片/留白/字号层级） | v0.10 §9 | 未开始 | 等信息架构稳定后一次做，避免返工 |
| L2 即时注入（query_data 自动附卡片/指标） | v0.10 §9.1 | 设计已预埋，未实施 | 触发条件/已交付清单/预算（≤200 token、2 张表）设计完成，待 A-3/A-4 使用反馈 |
| MCP 服务暴露知识库 | v0.10 §9 | 未开始 | 仅当需要 pi 之外 Agent 共享时再做 |

## 工程与技术债

| 事项 | 来源版本 | 当前状态 | 备注 |
|------|----------|----------|------|
| JSON → YAML 全量迁移 | v0.2 §1.3 | 未开始 | 用户价值低、迁移风险高，长期挂起 |
| 复杂 replay log | v0.2 §1.3 | 未开始 | 工程治理项，不影响核心体验 |
| requirements.txt 版本钉死冲突 | v0.11（T-1 实测发现） | 部分（已装最新兼容组合绕过） | 原钉死版本组合 pip 解析失败；测试环境改用不锁版本安装，正式发布前需重新固化版本矩阵 |
| config.ts DEFAULTS 路径固化 | v0.11（T-3 实测发现） | 未开始 | `projectConfigDir`/`dbPath` 等在模块加载时由 process.cwd() 算成绝对路径，`loadConfig({cwd})` 的 cwd 覆盖无法隔离这些目录，影响测试隔离与多实例场景 |
| 测试夹具 iris.csv 路径脆弱 | v0.11（T-1 迁移实测） | 已缓解（fixtures 目录收口） | 迁移后 fixture 引用统一走 `src/eval/fixtures/`，如再出现路径问题优先检查 vitest root 配置 |
