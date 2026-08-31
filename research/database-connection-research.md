# 主流数据库接入方案调研（MySQL / PostgreSQL）

> 调研日期：2026-08-30　|　调研对象：`/Users/mare/pi-agent/pi-data-agent-extension`
> 现状：DuckDB v1.5.4（实测 `SELECT version()`）、`@duckdb/node-api` ^1.5.4-r.1、`@earendil-works/pi-coding-agent` 0.79.10（npm 最新 0.84.4）
> 标注约定：**【实测】** = 本机跑出来的结果；**【文档】** = 官方文档/仓库声明；**【未查到】** = 查不到，不编造

---

## 1. 结论先行

### 推荐：DuckDB 原生扩展路线（`INSTALL mysql` + `ATTACH ... (TYPE MYSQL, READ_ONLY)`），**不用 MCP**

**一句话理由**：项目架构是「所有分析都在本地 DuckDB 里做」，DuckDB 原生扩展让远程表在 SQL 层面直接变成 DuckDB 的表，现有 15 个工具、310 个用例、可视化/报告/字典全链路**零改动**即可复用；而 MCP 在本项目里不是"接一个 server"，是"先补一个 Pi 核心明确拒绝实现的能力"。

### 用户假设的验证结果：MCP 不是答案（至少不是第一答案）

Pi 核心**明确不做 MCP**，这不是能力缺失而是设计决策：

- 已安装包 README（v0.79.10）原文：**"No MCP.** Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support."【文档】
- `node_modules/@earendil-works/pi-coding-agent/docs/usage.md` 原文："It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash."【文档】
- 对整个 `@earendil-works` 已安装包的 `dist/` 目录 grep `mcp|modelcontext`，命中数 **0**（唯一命中的是 README/docs 里的文字说明和 `@anthropic-ai/sdk` 的无关文件）【实测】
- 官方理由（Mario Zechner, 2025-11-02）：Playwright MCP 21 个工具占 13.7k tokens，Chrome DevTools MCP 26 个工具占 18.0k tokens；且"MCP servers also aren't composable — 结果必须经过 agent 的 context 才能落盘或与其他结果合并"【文档】

**这最后一条对本项目是致命的**：本项目的核心价值是「读进来 → 落 DuckDB 表 → SQL 分析 → 可视化/报告」，中间任何一环经过 LLM context 都是倒退。MCP 返回的结果**天然要过 context**，而 DuckDB ATTACH 后的表**天然不过 context**。

### 这个方案在什么条件下会失败

1. **目标 MySQL 是 5.5 / 5.6 或 MariaDB 老版本**：libmariadb 3.4.7 客户端兼容性、服务端 `MAX_EXECUTION_TIME` hint（5.7.8+）缺失会让超时保护失效。
2. **要分析的表是千万行级且必须全量**：`CREATE TABLE local AS SELECT *` 会全量拉取到本机 DuckDB 文件，网络 + 磁盘 + 内存三重成本，本项目的 `.pi-data-agent/session.duckdb` 会迅速膨胀。
3. **DBA 只给读写账号 + 审计要求**：DuckDB 扩展的 `READ_ONLY` 是**客户端侧**约束（见 §5-R3），绕过成本极低，无法替代服务端只读账号。
4. **环境无外网且未预置扩展**：首次 `INSTALL mysql` 实测需联网下载 10 MB（见 §4.2），离线环境会直接失败。

---

## 2. 方案对比表

| 维度 | **A. DuckDB 原生扩展**（推荐） | **B. MCP server** | **C. 直接驱动（mysql2 / pg）** |
|---|---|---|---|
| **接入成本** | 低。`ATTACH` 一行 SQL + secrets，扩展自动下载。核心改动集中在 `connect-database.ts` 一个文件 | **高**。Pi 核心不支持 MCP，要么引第三方 extension（`pi-mcp-adapter`），要么自己实现 MCP client（`@modelcontextprotocol/sdk` Client + StdioClientTransport + 子进程生命周期 + tools/list + tools/call） | 中。新增 npm 依赖 + 写「查询 → 转 Arrow/JSON → 灌 DuckDB」的搬运层，类型保真要自己兜 |
| **类型保真** | 中高，由扩展统一处理（见 §4.4）。坑：`DECIMAL(p>38)`→`DOUBLE` 丢精度；`TIME`→`VARCHAR`；`JSON`→`VARCHAR` | 取决于 server 实现。多数 server 把结果 JSON 序列化返回，DECIMAL/BIGINT/DATETIME 走 JSON 时二次失真 | **最高**。可逐列控制映射，BIGINT 可用 BigInt/字符串保留，DECIMAL 可强制字符串 |
| **大数据量表现** | 好。**filter/aggregate/order pushdown 默认开启**【实测 `mysql_aggregate_pushdown_enabled=true`、`mysql_order_pushdown_enabled=true`、`mysql_experimental_filter_pushdown=true`】，`SELECT count(*) FROM remote_tbl` 在远端算完只回一个数字 | 差。结果必须过 LLM context；`@pi-unipi/mcp` 对文本结果有 **64 KiB 硬上限**（超出写 `~/.unipi/tool-results/` 再让 agent 用 read 取）【文档】 | 中。可控流式（`connection.query().stream()`）分批灌入，但需要自己写分页、背压、断点续传 |
| **安全边界** | 中。可控点：secrets manager、`READ_ONLY`、`mysql_query_timeout_max_ms=300000`（默认已开）、`mysql_pool_size=12`。但**无 host 白名单机制**，需自建 | 中。server 侧有 readonly / max_rows / 超时，但**多了一个第三方进程持有生产库凭据**，且该进程由 Pi 拉起、生命周期不在本项目控制内 | 高。所有 SQL、超时、行数上限、连接池都在本项目代码里，可精确收口 |
| **凭据管理** | **好**。`CREATE SECRET ... (TYPE MYSQL, ...)` 受支持【实测】，见 §4.5 的**决定性差异** | 中。env 传参（`MYSQL_PASS` / `DBHUB_DSN`），配置落在 `mcp.json` 明文文件里 | 中。同 MCP，env 或配置文件，代码可控 |
| **新增依赖** | **0 个 npm 包**。扩展二进制 29 MB（下载 10 MB gz），落 `~/.duckdb/extensions/v1.5.4/osx_arm64/` | `pi-mcp-adapter`（第三方，非本项目维护）或 `@modelcontextprotocol/sdk` 1.30.0 + 一个外部 server 进程（npx 拉起，供应链风险） | `mysql2` 3.24.2 / 608 KB（published 2026-08-24【实测 npm view】）、`pg` 8.23.0 / 100 KB（2026-08-08） |
| **与现有架构贴合度** | **极高**。ATTACH 后 `alias.table` 就是普通 DuckDB 表，`query_data` / `describe_data` / `visualize` / `generate_report` / 数据字典全部直接可用 | 低。MCP 工具是"外部能力调用"，与 DuckDB 表模型是两套世界，要额外写一个"把 MCP 结果落表"的桥 | 中。落表后与架构一致，但搬运层是自研且要长期维护类型映射 |
| **维护风险** | 中。**DuckDB 官方 core extension，但 Support tier 是 Secondary（best-effort）**【文档】。仓库 duckdb/duckdb-mysql 101 star / 19 open issue，最后 push 2026-08-28（2 天前）【实测 GitHub API】 | **高**。生态碎片化：`@modelcontextprotocol/server-*` 参考实现**已归档**；`donghao1393/mcp-dbutils` 最后提交 2025-05-12（已死 15 个月）；`mysql/mysql-mcp-server` **根本不存在**（404） | 低。`mysql2` / `pg` 是 npm 事实标准，更新活跃，只有两个包 |

---

## 3. 推荐路线的落地路径

### 阶段 1：MySQL 只读查询（P0，最小可用）

目标：把 `connect_database` 的 `if (dbType !== "sqlite") return unsupported` 换成「mysql 也走同一条 ATTACH 路径」，但**强制 READ_ONLY + 强制 secret + 强制 host 白名单**。

| 文件 | 改动 |
|---|---|
| `src/tools/connect-database.ts:63-69` | 删除硬编码 `if (dbType !== "sqlite") return unsupported` 拦截（全文 216 行）。参数 schema 从 `file_path` 扩为 `connection`（host/port/user/database/secret_name）。**构造 SQL 时禁止拼接密码**（见 §5-R1） |
| `src/security.ts` | 新增 `checkRemoteTarget(host, port) → allow/block`。白名单读取新配置项，`checkSql` 之外增加独立入口；沿用现有 fail-closed 风格（`resolveConfirmGate` 已有三态判定可直接复用） |
| `src/config.ts` | `AppConfig` 增 `dbAllowedHosts: string[]`（默认 **空数组 = 拒绝一切远程连接**，保证现有行为不变）、`dbQueryTimeoutMs`、`dbMaxMaterializeRows`；`ENV_MAP` 增 `PI_DATA_AGENT_DB_ALLOWED_HOSTS` |
| `src/types.ts` | `SecurityConfig` 同步扩展 |
| `src/engine/duckdb.ts` | 新增 `attachRemote(spec)` 封装：先 `CREATE OR REPLACE SECRET`（temporary，不落盘），再 `ATTACH '' AS x (TYPE MYSQL, SECRET name, READ_ONLY)`，最后设 `SET mysql_query_timeout_max_ms` |
| `src/audit-log.ts` | 确保 ATTACH 异常信息落审计前经过脱敏（明文串 ATTACH 的 error 会含密码，见 §4.5） |
| 新增 `src/eval/connect-mysql.test.ts` | 至少 8 用例：白名单内/外、secret 缺失、READ_ONLY 拒绝 INSERT、超时设置生效、密码不出现在任何返回文本中 |

工作量：**3–5 人天**（含测试与验收）。风险最低，可独立交付。

### 阶段 2：物化到本地再分析（P1，真正释放价值）

目标：`CREATE TABLE local AS SELECT * FROM mysql_db.remote_tbl`，让远程数据变成项目的一等公民数据集（`list_datasets` / 字典 / 可视化全链路可用）。

| 文件 | 改动 |
|---|---|
| 新增 `src/tools/materialize-remote-table.ts` | 新工具。参数：`alias`、`table`、`target_table?`、`row_limit?`、`columns?`。内部：`SELECT count(*)` 先探规模 → 超阈值走确认门 → `CREATE TABLE ... AS SELECT`（**禁止用 `mysql_query()`**，见 §4.6） |
| `src/security.ts` | 新增行数/字节预算检查；确认门文案必须打印预估行数与预估耗时 |
| `src/config.ts` | `dbMaxMaterializeRows`（默认建议 500_000）、`dbMaterializeConfirmRatio` |
| `src/engine/duckdb.ts` | 物化前后记录 `.duckdb` 文件体积变化，超 `dbMaxDbSizeMb` 熔断回滚 |
| `src/dictionary/` | 物化后的表自动进字典，与 CSV 上传路径对齐 |
| 新增 `src/eval/materialize-remote.test.ts` | 大表熔断、LIMIT 注入、物化失败不留脏表（`DROP TABLE IF EXISTS` 回滚） |

工作量：**4–6 人天**（主要成本在大表熔断策略与测试替身）。

### 阶段 3：PostgreSQL + 多库统一（P2）

| 文件 | 改动 |
|---|---|
| `src/engine/duckdb.ts` | 抽象 `RemoteDbDialect { type, secretType, settingsPrefix }`，mysql/postgres 两套配置 |
| `src/security.ts` | 白名单结构从 `host[]` 扩为 `{host, port, dbType}[]` |
| `src/config.ts` | `pgStatementTimeoutMs` —— **必须显式设置**，`pg_statement_timeout_millis` 默认为 `null`（无超时）【实测】，与 mysql 侧默认 300s 不对等 |
| 新增 `src/eval/connect-postgres.test.ts` | 与 MySQL 用例对称 |

工作量：**3–5 人天**。三阶段合计 **10–16 人天**。

### 明确的"不做"清单

- 不做**写回**生产库（DuckDB 扩展支持 `INSERT`/`UPDATE`/`CREATE TABLE` 到 MySQL，但本项目开了口子就等于把 fail-closed 安全模型撕开）
- 不引入 MCP server 作为数据通路；若将来要做，只做 BACKLOG 里已挂着的「MCP 服务暴露知识库」（**出口**，不是入口），那是另一个方向
- 不做连接池常驻：DuckDB 扩展自带 pool（`mysql_pool_size` 默认 12，`mysql_pool_connection_idle_timeout_millis=60000`）【实测】，够用

---

## 4. 证据

### 4.1 DuckDB MySQL 扩展：状态与归属

| 项 | 值 | 来源 |
|---|---|---|
| 官方属性 | **core extension**，Maintainer = DuckDB team | https://duckdb.org/docs/current/core_extensions/overview （访问 2026-08-30） |
| Support tier | **Secondary** — "supported on a best-effort basis... they still receive frequent bugfixes/updates and are shipped with new DuckDB releases" | 同上 |
| 仓库 | `duckdb/duckdb-mysql`，MIT | GitHub API，2026-08-30 |
| Star / open issues | **101 / 19** | GitHub API，2026-08-30 |
| 最后 push | **2026-08-28T22:13:54Z**（2 天前） | GitHub API，2026-08-30 |
| 最近三个提交 | "Update vcpkg and libmariadb"(08-28)、"Synchronize catalog cache lookup with clearing"(08-27)、"Only sync the first MySQL connection (main)"(08-27) | GitHub API commits |
| 别名 | `mysql` / `mysql_scanner` | DuckDB docs |

对照 `duckdb/duckdb-postgres`：**372 star / 51 issues / MIT / 最后 push 2026-08-29T12:45:37Z**（1 天前）【实测 GitHub API】。PG 侧社区体量是 MySQL 侧的 3.7 倍，issue 也更多（51 vs 19）。

### 4.2 底层机制、体积、联网需求（全部【实测】于本机 DuckDB v1.5.4 / macOS arm64）

- **客户端库**：扩展二进制内 `strings` 命中 `local_vcpkg_installation/buildtrees/libmariadb/src/v3.4.7-1a419836a4.clean/libmariadb/secure/openssl.c` 与 `LIBMYSQL_PLUGINS`、`libmariadb` → **libmariadb 3.4.7 静态链接进扩展**。仓库侧佐证：commit "Use libmariadb client library instead of libmysql"（2025-11-13）。
  → **结论：本机无需安装 MySQL 客户端库**。（注意：这同时意味着它对 MariaDB 的兼容性好于对 Oracle MySQL 新特性。）
- **体积**：`mysql_scanner.duckdb_extension` = 30,858,310 B（29 MB，落盘后）；**gz 下载 10,200,614 B（约 10 MB）**（`curl -sI` 的 content-length）。对照 `postgres_scanner` 30,885,462 B、`sqlite_scanner` 26,940,342 B。
- **首次 INSTALL 需要联网**：`INSTALL mysql` 耗时 **3991 ms**，`INSTALL postgres` **5244 ms**；安装到 `~/.duckdb/extensions/v1.5.4/osx_arm64/`，来源 `http://extensions.duckdb.org/v1.5.4/osx_arm64/*.duckdb_extension.gz`（读自 `.info` 文件）。
- **SQLite 现状**：当前代码里**没有任何 `INSTALL`/`LOAD`**（grep `INSTALL|LOAD |loadExtension` 全仓 0 命中业务代码），但实测 `sqlite_scanner` 初始状态为 `NOT_INSTALLED`，而 `ATTACH ':memory:' AS s1 (TYPE SQLITE)` **成功** → 依赖 DuckDB 的自动安装/自动加载。**这条路径在离线环境下会失败，是现有代码的隐含脆弱点**，与本项目新增 MySQL 时遭遇的问题同源，建议一并在阶段 1 修掉（显式 INSTALL + 失败降级提示）。

### 4.3 关键能力边界

- **直接查询**：`ATTACH 'host=.. user=.. password=.. database=..' AS x (TYPE MYSQL)` 后 `SELECT * FROM x.tbl` 直接读远端【文档】。
- **物化到本地**：官方文档明确支持 `CREATE TABLE duckdb_table AS FROM mysqlscanner.mysql_table`，并注明 "It might be desirable to create a copy of the MySQL databases in DuckDB to prevent the system from re-reading the tables from MySQL continuously, **particularly for large tables**"【文档 https://duckdb.org/docs/extensions/mysql】。
- **下推（决定大数据量表现）**，实测 `duckdb_settings()` 默认值：
  - `mysql_experimental_filter_pushdown = true`（名字仍带 experimental）
  - `mysql_aggregate_pushdown_enabled = true`
  - `mysql_order_pushdown_enabled = true`
  - `mysql_adaptive_replan_enabled = true`、`mysql_compression_aware_costs = true`
  - `mysql_use_binary_copy` 的对应项缺失；PG 侧有 `pg_use_binary_copy = true`
- **超时与缓冲**（实测默认值）：
  - `mysql_query_timeout_enabled = true`，描述 "Add MAX_EXECUTION_TIME hint to MySQL queries for safety"
  - `mysql_query_timeout_min_ms = 5000`、`mysql_query_timeout_max_ms = 300000`
  - `mysql_sql_buffer_result = true`，描述 "Add SQL_BUFFER_RESULT for large result sets to release row locks faster" ← **大结果集时把压力推给服务端，反向影响生产库，DBA 可能不喜欢**
  - `mysql_pool_size = 12`、`mysql_pool_connection_idle_timeout_millis = 60000`、`mysql_pool_wait_timeout_millis = 30000`
  - PG 侧 `pg_statement_timeout_millis = null`（**默认无超时**）、`pg_connection_limit = 12`、`pg_pages_per_task = 1000`
- **大数据量的坑（未在真库上实测，属推断 + 文档）**：
  - 无 `mysql_pages_per_task` 之类的分块参数（PG 侧有 `pg_pages_per_task`），MySQL 侧并行度控制面窄
  - 物化是全量单语句，中途失败不会自动回滚到"部分物化"之外 → 必须在工具层用 `CREATE TABLE tmp_xxx AS SELECT` + 成功后 rename 的模式
  - `mysql_debug_show_queries = false` 若被打开会**把所有发往 MySQL 的 SQL 打到 stdout** → 配置护栏里应禁止开启

### 4.4 类型映射已知坑

来源：DeepWiki 对 `src/mysql_types.cpp` 的逐行索引（https://deepwiki.com/duckdb/duckdb-mysql/4.2-type-mapping-and-conversion，访问 2026-08-30）。

| MySQL 类型 | DuckDB 映射 | 坑 |
|---|---|---|
| `tinyint(1)` | **BOOLEAN**（默认） | 由 `mysql_tinyint1_as_boolean=true` 控制。若业务里 `tinyint(1)` 存的是 0/1/2 三态枚举，会被误读为布尔 |
| `tinyint/smallint/mediumint/int/bigint` | TINYINT/…/BIGINT，带 unsigned 变体（UTINYINT…UBIGINT） | `BIGINT UNSIGNED` → `UBIGINT`，**DuckDB 侧没有问题**，但后续若 JSON 序列化给前端/LLM，超过 `Number.MAX_SAFE_INTEGER` 会丢精度 |
| `decimal(p,s)` | `DECIMAL(p,s)` **仅当 p ≤ 38**；否则 **DOUBLE** | **精度丢失**。金融金额必须校验 p，或在物化时显式 `CAST(... AS VARCHAR)` |
| `datetime` | TIMESTAMP，**timezone unaware** | 时区语义需靠 `mysql_session_time_zone` 对齐（默认为空） |
| `timestamp` | TIMESTAMP，treated as local timestamp | 与 datetime 行为不一致 |
| `time` | **VARCHAR**（默认） | `mysql_time_as_time=false` 的原因：MySQL TIME 范围 -838:00:00 ~ 838:00:00 超出 DuckDB TIME。开启该开关后超范围值**直接报错** |
| `json` | **VARCHAR** | 需自行 `json_extract`，不能当结构化类型用 |
| `bit(1)` | BOOLEAN（默认），否则 BLOB | `mysql_bit1_as_boolean=true` |
| `enum` / `set` | VARCHAR | 枚举约束丢失 |
| `year` | INTEGER | |
| geometry | BLOB | 需 spatial 扩展才能解析 |
| 字符集/排序规则 | **未查到**扩展层的明确处理说明 | DuckDB 内部统一 UTF-8；`utf8mb4` 以外的字符集（如 `gbk`/`latin1`）未见文档保证，需实测 |

### 4.5 凭据传递：secrets manager 支持，且这是**决定性差异**

DuckDB secrets manager **支持 MySQL**【文档 + 实测】：

```sql
CREATE SECRET mysql_secret_one (
  TYPE mysql, HOST '127.0.0.1', PORT 0, DATABASE mysql, USER 'mysql', PASSWORD ''
);
ATTACH '' AS mysql_db_one (TYPE mysql, SECRET mysql_secret_one);
```

**实测对比（本机，连一个不存在的 127.0.0.1:13306）：**

| 方式 | 错误信息 | 是否泄漏密码 |
|---|---|---|
| 明文连接串 `ATTACH 'host=.. password=supersecret ..'` | `IO Error: Failed to connect to MySQL database with parameters "host=127.0.0.1 port=13306 user=x password=y database=z": Can't connect to server on '127.0.0.1' (36)` | **是** —— 整条连接串含明文密码进了异常文本 |
| secret 方式 `ATTACH '' AS m (TYPE MYSQL, SECRET s1)` | `IO Error: Failed to connect to MySQL database with parameters "": Can't connect to server on '127.0.0.1' (36)` | **否** |

**这条实测结果直接决定了实现规范**：本项目的 `AgentToolResult.content[].text` 会进 LLM context，`audit-log.ts` 会落盘，`src/error-recovery.ts` 会包装后再次抛给模型。用明文连接串 = 密码必然泄漏到 context + 日志 + 会话文件。
→ **强制 secret 方式**，且建议在 `connect_database` 返回前对 error message 做一次 `password=***` 兜底脱敏（防御未来有人改回明文串）。

secrets 默认是 temporary（不落盘）；`CREATE PERSISTENT SECRET` 可跨会话。**建议默认 temporary**，避免凭据进 `.duckdb` 文件（该文件在项目目录下，会被 git/dashboard 碰）。

### 4.6 `mysql_query()` 的坑：不要用

历史 issue `duckdb/duckdb_mysql#65`（2024）：`SELECT * FROM mysql_query('sdb', 'select col1, col2 from mysql_table')` 对 `DECIMAL(19,2)` 列返回**全 NULL**，且返回类型随选中行变化；而 `CREATE OR REPLACE TABLE duckdb_my_table AS SELECT * FROM mysqldb.my_table` 正常。
→ **物化与查询都走「表扫描」路径，禁止用 `mysql_query()` 做原始数据读取**。（该 issue 为 2024 年记录，未验证在 v1.5.4 是否已修；规避成本为零，直接规避。）

### 4.7 MCP 生态盘点（全部 GitHub API 实测，2026-08-30）

**"官方 MySQL MCP server"不存在**：`mysql/mysql-mcp-server` → 404。
`@modelcontextprotocol/server-*` 系列的数据库参考实现**已归档**：仓库 README 显示 SQLite 等已进入 `servers-archived`；第三方 server 列表已于 2026-04-14 退役，改由 MCP Registry 承接【文档】。

| 实现 | 维护方 | Star | 最后 push | License | 工具 | 只读 | 凭据 |
|---|---|---|---|---|---|---|---|
| `benborla/mcp-server-mysql` | 社区 | 2,089（43 issues） | 2026-07-27 | MIT | `mysql_query` + resource `mysql://tables` | **默认只读**；写需 `ALLOW_INSERT_OPERATION` / `ALLOW_UPDATE_OPERATION` / `ALLOW_DELETE_OPERATION` | env `MYSQL_HOST/PORT/USER/PASS/DB` |
| `designcomputer/mysql_mcp_server` | 社区 | 1,373（1 issue） | 2026-08-02 | MIT | 表枚举 / 读表内容 / 执行 SQL | 未在其 README 声明默认只读 | env |
| `bytebase/dbhub` | Bytebase（商业公司） | 3,429（**3 issues**） | 2026-08-21 | MIT | `execute_sql`、`search_objects`（默认仅 2 个，**1.4k tokens**）；opt-in `explain_sql`、`health_check` | 支持 readonly mode + `max_rows` + query timeout | `--dsn` 或 TOML 里 `${ENV_VAR}` |
| `crystaldba/postgres-mcp` | 社区 | 3,239（89 issues） | 2026-08-17 | MIT | — | 可配置 read/write | — |
| `oracle/mcp` | **Oracle 官方** | 431 | 2026-08-24 | **UPL-1.0** | — | — | — |
| `FreePeak/db-mcp-server` | 社区 | 417 | 2026-08-24 | MIT | 多库自动生成 per-db 工具 | — | — |
| `donghao1393/mcp-dbutils` | 社区 | 90 | **2025-05-12** | MIT | — | — | — |

**多库统一方案值得关注吗？** `bytebase/dbhub` 是唯一一个数据上说得通的（3,429 star、**仅 3 个 open issue**、9 天前有提交、5 种库、2 个工具 1.4k tokens 的 token 效率、内置 readonly + max_rows + timeout + `truncated` 标记）。**但它解决的是"给通用 MCP client 接库"的问题，而本项目不是通用 MCP client**，且用它仍然要额外装一个 MCP runtime（`pi-mcp-adapter` 或自研 client），还要接受 64 KiB 结果上限。**结论：dbhub 是好产品，但不在本项目的最短路径上。**

### 4.8 若一定要走 MCP：在 Pi extension 内嵌 client 的成本

- `ExtensionAPI` 提供 `exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>`【实测读 `dist/core/extensions/types.d.ts`】→ **可以** spawn 子进程，stdio 传输的前置条件具备。
- 技术选项：`@modelcontextprotocol/sdk` **1.30.0**（npm published 2026-07-27【实测】）的 `Client` + `StdioClientTransport`。
- 现存第三方 extension（免自研，但引入外部维护依赖）：
  - `pi-mcp-adapter`（`nicobailon/pi-mcp-adapter`）：1,364 star，MIT，最后 push 2026-08-29，npm 2.31.0（2026-08-28）。单 proxy tool ~200 tokens，lazy 连接，支持 stdio / StreamableHTTP。
  - `@pi-unipi/mcp` 2.14.1（2026-08-27）：browse 7,800+ server 的目录并注册为 `{serverName}__{toolName}`。
- **成本估算（自研）**：MCP client 生命周期管理（spawn / stdio 帧解析 / reconnect / idle timeout / 进程泄漏防护）+ 动态工具注册 + 结果落表桥 + 错误映射 ≈ **8–12 人天**，且此后项目要长期跟进 MCP spec 演进。用第三方 adapter 则约 **2–3 人天**集成，但**把凭据与生产库连接交给一个非本项目维护的社区包**。
- 额外约束【文档 @pi-unipi/mcp】：文本结果 **64 KiB 硬上限**；Pi 0.84 **无法移除动态注册的工具**（改配置须重启）。

### 4.9 直接驱动路线

- `mysql2` **3.24.2**（npm published 2026-08-24），unpacked **608 KB**；`pg` **8.23.0**（2026-08-08），unpacked **100 KB**【实测 `npm view`】。
- 优势：类型完全可控（DECIMAL 走字符串、BIGINT 走 BigInt）、可流式（`query().stream()`）分批灌入并随时熔断、超时/重试/SSL 全在代码里、无外部进程。
- 劣势：要自己写「远端类型 → DuckDB DDL → 批量 INSERT/Appender」的搬运层；**下推能力归零**——`SELECT count(*) FROM remote_tbl` 会真的把全表拉回来再数，这是与扩展路线最大的性能差距。
- **定位：不是推荐主线，而是 DuckDB 扩展的逃生舱**——当遇到扩展不支持的类型（如 `DECIMAL(p>38)` 必须保精度）或目标库版本不兼容时，作为单表物化的降级实现。

---

## 5. 风险清单

### 5.1 方案 A（DuckDB 原生扩展）

- **R1｜凭据泄漏进 LLM context 与日志。** 明文 ATTACH 的异常信息含完整连接串（§4.5 实测）。触发条件：任何一次连接失败（host 不通、账号错、库不存在）。缓解：强制 secrets、temporary secret（不落盘）、异常文本二次脱敏、审计日志脱敏。**这是本项目最容易被忽略、后果最严重的一条。**
- **R2｜离线/受限网络环境下 `INSTALL mysql` 直接失败。** 首次需下载 10 MB（实测 4 秒）。触发条件：内网开发机、CI、air-gapped 环境。缓解：预置扩展到项目目录 + `SET extension_directory`，或提前 INSTALL 并捕获 `IO Error` 给出明确指引。注意现有 SQLite 路径同样依赖自动下载，是同一类隐患。
- **R3｜`READ_ONLY` 是客户端侧约束，不是服务端保证。** 它挡的是"agent 误操作"，挡不住"agent 故意去掉该参数重发一条 ATTACH"（SQL 是模型生成的，模型能看到工具描述）。触发条件：prompt injection、模型幻觉改 SQL。缓解：**服务端只读账号是唯一真正的保障**，客户端 `READ_ONLY` 只作为第二道；`security.ts` 应在 SQL 层拦截任何对 remote alias 的 `ATTACH`（禁止 agent 自行 ATTACH，只走 `connect_database` 工具构造好的路径）。
- **R4｜大表物化把本机打爆。** `CREATE TABLE AS SELECT` 全量拉取，`.pi-data-agent/session.duckdb` 无上限增长。触发条件：agent 或对一张 5000 万行表做物化。缓解：物化前先 `SELECT count(*)`（下推，代价低）→ 超阈值走确认门 → 落盘体积熔断 → 物化用临时表名 + 成功后 rename。
- **R5｜`mysql_sql_buffer_result = true` 把压力推给生产库。** 默认开启，大结果集时服务端要物化整个结果集。触发条件：并发分析 + 大查询。缓解：视 DBA 要求显式 `SET mysql_sql_buffer_result = false`；并强制只读副本。

### 5.2 方案 B（MCP）

- **R6｜前提不成立：Pi 没有内置 MCP，集成成本被严重低估。** 用户假设「接一个现成 MCP server」≈ 1 人天，实际是 2–3 人天（引第三方 adapter）或 8–12 人天（自研 client），且从此多一个非本项目维护的外部依赖持有生产库凭据。
- **R7｜MCP 生态碎片化且归档率高。** `@modelcontextprotocol/server-*` 数据库参考实现已归档；`mcp-dbutils` 已 15 个月无提交；头部 MySQL server 最后提交距今 34 天、PG 侧 13 天。触发条件：MCP spec 版本升级 / 依赖链 CVE / 维护者弃坑。缓解：若采用，选 `bytebase/dbhub`（商业公司背书、3 个 open issue、9 天前有提交）并锁定版本。
- **R8｜结果必经 LLM context，与本项目架构根本冲突。** 64 KiB 硬上限意味着稍大的查询结果就要"写文件再让 agent 读"，把一个 SQL 往返变成多轮工具调用。触发条件：任何超过几百行的结果集 —— 也就是数据分析的常态。
- **R9｜新增一个持有生产库凭据的常驻/半常驻第三方进程。** 该进程由 Pi 拉起，其生命周期、日志、错误处理均不在本项目的安全模型内（`security.ts` / 7 层 dashboard 中间件管不到它）。触发条件：MCP server 自身把 DSN 打进日志或崩溃转储。

### 5.3 方案 C（直接驱动）

- **R10｜下推能力归零，聚合查询退化成全表拉取。** DuckDB 扩展默认开启 filter/aggregate/order pushdown（§4.3 实测），自研驱动没有。触发条件：`SELECT count(*) FROM remote_big_table` —— 扩展路线是远端算完回 1 个数字，驱动路线是全表拉回本地再数。这个差距在千万行表上是"秒级 vs 分钟级"。
- **R11｜类型映射要自己维护，且是长期负债。** `mysql2` 对 DECIMAL/DATE 的默认序列化行为（Date 对象受 `dateStrings` 影响、时区受连接参数影响）与 DuckDB 期望不一致，每新增一种类型都要补一对映射 + 测试。触发条件：遇到没覆盖的类型（geometry / set / 特殊字符集）。缓解：仅作为 §4.9 所述的逃生舱，限定覆盖常用类型。

### 5.4 三条路线共有的全新攻击面：网络出口

项目此前是纯本地工具（`localOnly` + `hostCheck` 中间件、路径白名单），引入数据库连接后**首次出现对外网络出口**，这会绕过现有安全模型的假设：

1. **连接目标白名单**：`config.dbAllowedHosts`，**默认空 = 拒绝一切远程连接**；支持 host / host:port / CIDR；`security.checkRemoteTarget()` 做 fail-closed 判定（复用 `resolveConfirmGate` 的三态语义）。
2. **强制只读账号**：文档层面要求用户提供 `GRANT SELECT ONLY` 账号；工具描述里写明「本工具不会也不可用于写入」。服务端授权是唯一真实边界。
3. **结果行数上限**：物化路径强制注入 LIMIT（参考 `src/engine/duckdb.ts:268` 已有的 `buildPreviewSql` 逻辑，但那是预览用的，物化需要独立阈值 `dbMaxMaterializeRows`）；查询路径沿用 `executeQueryWithLimit`（`src/engine/duckdb.ts:200`）。
4. **超时**：MySQL 侧默认 300 s 已够；PG 侧 `pg_statement_timeout_millis` 默认 `null`，**必须显式设置**。
5. **禁止 DDL/DML**：`security.ts` 的 `classifySql` 已能分 read/write/dangerous，需新增规则——**任何指向 remote alias 的 ATTACH/INSERT/UPDATE/DELETE/DROP 一律 block**（不是 confirm，是 block）。
6. **凭据不入 LLM context**：连接串只允许出现在 `CREATE SECRET` 语句中；该语句永不进 `AgentToolResult.content`；`audit-log.ts` 落盘前脱敏；`.pi-data-agent/config.json` 只存 secret **名称**与 host，不存密码；密码来源优先 `MYSQL_PWD` 等环境变量（DuckDB 扩展原生支持从 `MYSQL_PWD` / `MYSQL_HOST` / `MYSQL_USER` / `MYSQL_DATABASE` / `MYSQL_TCP_PORT` 读取【文档】），或交互式 UI 输入（`ExtensionUIDialogOptions`，走 `ctx.ui`）。
7. **Dashboard 侧**：7 层中间件里的 `localOnly` 保证 UI 只本机可访问，但数据库连接是从 extension 进程发起的，不经过 Express。需在 dashboard 的「连接」视图里显式展示当前活跃的远程连接与白名单，避免"界面上看不出正在连外网"。

---

## 附：待验证项（本次无条件实测）

- 真机 MySQL / PostgreSQL 上的物化性能、并发下推表现 —— **未实测**（本机无可用服务端）
- `utf8mb4` 以外字符集（gbk / latin1）的读取正确性 —— **未查到**明确文档，需实测
- `ATTACH ... (TYPE MYSQL, READ_ONLY)` 的拦截强度（是否覆盖所有写路径）—— **未实测**，仅文档声明
- `mysql_query()` 的 DECIMAL 问题在 v1.5.4 是否已修复 —— **未验证**（issue #65 为 2024 年记录）
