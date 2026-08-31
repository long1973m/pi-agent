# 其他主流数据库支持调研（PostgreSQL / SQLite / SQL Server / Oracle / MongoDB / ClickHouse / 国产库）

> 调研日期：2026-08-31　|　前置文档：`research/database-connection-research.md`（MySQL 主线，必读）
> 基线：DuckDB v1.5.4（`@duckdb/node-api` ^1.5.4-r.1）
> 标注约定：**【实测】**= 本机/GitHub API 跑出来的结果；**【文档】**= 官方文档声明；**🔴待验证** = 未实测，接入前必须先验

---

## 1. 结论先行

**能加，而且越加越便宜。** 核心判断：DuckDB 的 ATTACH 扩展机制把「接一个新数据库」从"新架构问题"降级成"方言清单问题"——只要目标库有 DuckDB 扩展，接入 = 一套 `{secretType, settingsPrefix, timeout默认值}` 配置 + 对称测试，v0.12 阶段 3 规划的 `RemoteDbDialect` 抽象天然就是为了这个。

按接入成本分三档：

| 档位 | 数据库 | 依据 |
|---|---|---|
| **第一档：核心扩展（官方 DuckDB team 维护）** | PostgreSQL、SQLite | 与 mysql 同属 core extension、Support tier 同为 Secondary【文档，core extensions overview，2026-08-31】 |
| **第二档：社区扩展（第三方维护，按需评估）** | SQL Server、Oracle、BigQuery、Snowflake | community extensions 列表【文档，2026-08-31】 |
| **第三档：无扩展旁路（导出落表）** | MongoDB、ClickHouse、Elasticsearch、Db2 | 官方社区扩展列表中不存在对应连接器【文档，2026-08-31】 |

**建议节奏**：v0.12 只做 MySQL（阶段 1）+ 物化（阶段 2）+ PostgreSQL（阶段 3，原计划）；SQL Server 挂 BACKLOG 等真实需求触发；Oracle/Mongo/ClickHouse 只留旁路设计，不提前投入。

---

## 2. 覆盖矩阵

| 数据库 | DuckDB 扩展 | 归属 | 维护健康度【实测 GitHub API，2026-08-31】 | 接入方式 | 建议 |
|---|---|---|---|---|---|
| **PostgreSQL** | `postgres`（postgres_scanner） | **core**，DuckDB team | 372★ / 51 issues / 最后 push 2026-08-29（前份调研实测） | `ATTACH (TYPE POSTGRES, SECRET s, READ_ONLY)` | **v0.12 阶段 3 做**，`pg_statement_timeout_millis` 默认 `null` 必须显式设 |
| **SQLite** | `sqlite`（sqlite_scanner） | **core**，DuckDB team | 体积 26.9 MB，自动加载可用【前份调研实测 §4.2】 | 现有 `dbType: sqlite` 路径已走通 | **已支持**，仅需补"离线 INSTALL 脆弱点"修复（与 MySQL 阶段 1 同源） |
| **SQL Server** | `mssql`（TDS 协议含 TLS） | community，hugr-lab/mssql-extension | **127★ / 14 issues / MIT / 最后 push 2026-08-31**【实测】 | `INSTALL mssql FROM community` 后 ATTACH，secret type 🔴待验证 | **P2，有真实需求再接**。活跃度是社区扩展里最好的 |
| **Oracle** | `oracle_scanner`（免 Oracle 客户端） | community，krokozyab/quack-oracle | **0★ / 0 issues / Apache-2.0 / 最后 push 2026-08-29**【实测】 | ATTACH，secret type 🔴待验证 | **P3 谨慎**。维护者活跃但零社区采用信号——接它等于独自踩坑，遇到再评估 |
| **MongoDB** | **无扩展** | — | — | 旁路：`mongoexport --jsonArray` → NDJSON 文件 → `read_json_auto` 落表（复用现有文件导入管线） | 留旁路设计，不提前投入 |
| **ClickHouse** | **无扩展** | — | — | 候选①：ClickHouse 自带 PostgreSQL wire protocol（`postgresql_port`），用 `postgres` 扩展 ATTACH 🔴待验证；候选②：HTTP 导出落表 | 留旁路设计；候选① 成本极低但兼容性未验，接入前先验 |
| **人大金仓 KingbaseES** | 复用 `postgres`（PG 协议兼容） | — | — | 同 PostgreSQL | 国产化需求出现时优先验证，🔴待验证 |
| **达梦 DM8** | 无专属扩展；`odbc`（core）可达 | — | — | ODBC 路径需目标机装 DM 驱动，运维成本高 | 挂 BACKLOG，等合规类客户真需求 |
| **BigQuery / Snowflake** | 社区扩展 `bigquery` / `snowflake` | community | 未深查 | ATTACH | 云数仓需求出现时再评估 |

> 来源：DuckDB core extensions overview 与 community extensions 列表（duckdb.org，访问 2026-08-31）；mssql/oracle 维护数据为 GitHub API 实测。

---

## 3. 每个档位的失败条件

### 第一档（PG/SQLite）：和 MySQL 共享全部风险模型

前份调研的 R1–R5（凭据泄漏、离线 INSTALL、READ_ONLY 客户端约束、大表物化、服务端压力）逐条适用于 PG，仅超时默认值不同（§2 已标）。**新增失败条件**：目标"PG"实为 Aurora/兼容层时，个别系统函数差异可能让下推部分失效——但查询仍能跑，只是变慢，不阻塞。

### 第二档（community 扩展）：核心风险是**版本配对**

1. **扩展与 DuckDB 版本必须一一配对**：community 扩展按 DuckDB 版本单独编译发布。升级 `@duckdb/node-api`（如 1.5.4 → 1.6）后，`INSTALL mssql` 可能在新版本源上**暂时不存在**，ATTACH 直接失败。缓解：锁定 DuckDB 版本；升级前查 duckdb.org/community_extensions 确认目标版本已发布。
2. **安全语义未经验证**：mssql/oracle 扩展的 secret manager 支持、异常文本是否泄漏密码、READ_ONLY 拦截强度，**全部🔴待验证**——MySQL 侧 §4.5 的实测结论不能直接外推。
3. **维护者单人风险**：mssql 127★ 尚可，oracle_scanner 0★。任何一条 issue 都可能只有你自己遇到。

### 第三档（旁路落表）：丢掉下推，换来零风险

mongo/clickhouse 走「导出 → 落表」后，远端聚合下推能力归零（与前份调研 §4.9 直接驱动路线的 R10 同理）。但旁路天然只做批量物化，不做即席查询，所以这个差距是可接受的——代价是**数据新鲜度**（导出时刻的快照）。

---

## 4. 工作量估算（在阶段 3 `RemoteDbDialect` 抽象就位之后）

| 新增方言 | 工作量 | 说明 |
|---|---|---|
| PostgreSQL（core） | 3–5 人天 | 原阶段 3 估算不变，含对称测试 |
| SQL Server（community） | 4–6 人天 | +扩展可用性验证、版本锁定、secret/超时语义实测 |
| 无扩展旁路（mongo/clickhouse，按个计） | 2–3 人天/个 | 复用现有「文件→表」导入管线，主要是导出命令编排 + 行数熔断 |

### 明确的"不做"清单（本篇新增）

- **不做 ODBC 全家桶**：`odbc` 扩展虽是 core，但要求每台目标机装对应客户端驱动（达梦/Db2/老 Oracle），运维成本与排障难度失控，只作为单点需求的逃生舱
- **不为低频库提前建方言**：Oracle、达梦、BigQuery 等在没有真实客户/数据源出现前，只在本表挂名
- **不引入 ADBC 间接层**：`adbc` 社区扩展理论上可达"任何有 ADBC 驱动的库"，但 MongoDB 等目标库的 ADBC 驱动生态不成熟🔴待验证，且多一层抽象多一层排障成本

---

## 5. 与 v0.12 的衔接

1. 阶段 1（MySQL 只读）的实现里，`RemoteDbDialect` 结构从第一天就按"多方言"设计（type / secretType / settingsPrefix / timeout 默认值表），**不要写死 mysql 字段**
2. SQLite 的离线 INSTALL 脆弱点并入阶段 1 一并修（前份调研 §4.2 已指出，同源问题）
3. BACKLOG 新增条目：SQL Server（mssql 社区扩展，触发条件=真实需求）、MongoDB/ClickHouse 旁路物化、KingbaseES 兼容性验证
