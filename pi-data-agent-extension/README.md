# Pi Data Agent Extension

基于 [Pi Extension API](https://pi.dev) + DuckDB 的数据分析智能体扩展：让 Pi 具备加载数据、SQL 查询、可视化、生成报告的完整分析能力，并以数据字典、查询记忆、表卡片三层知识库沉淀分析资产。

当前版本：**v0.14.4**（已发布 [npm](https://www.npmjs.com/package/pi-data-agent-extension)；易用性批次交付：Pi 打包、load_data F1/F2。问题与建议请提 [GitHub Issues](https://github.com/long1973m/pi-agent/issues)）。

## 功能概览

- **数据加载**：CSV / Excel（.xlsx/.xls）上传自动建表，DuckDB 本地存储
- **SQL 查询**：自然语言 → SQL，带错误自修复（error-recovery）与查询记忆
- **知识库**：数据字典（AI 推断 + 用户确认状态机）、表卡片、指标口径、查询记忆，按 L0 导航 / L1 按需 / L2 注入三层渐进披露；L2 在 query_data 结果前置语义附注（表卡片/指标口径/uncertain 警示，单次 ≤200 token、每轮 ≤2 表，可用 `PI_DATA_AGENT_L2_INJECTION=off` 关闭）
- **PM 分析模板（v0.13）**：`run_analysis_template` 一键跑漏斗 / 留存 cohort / A/B 检验——统计全部确定性计算（LLM 只解释不计算），uncertain 字段 fail-closed，结果自带"方法与局限"说明
- **可视化**：matplotlib 静态图（bar/line/scatter/histogram/pie/box/heatmap），Python 失败时自动回退 CSV
- **报告**：会话报告（HTML 单文件离线自包含）+ 正式分析报告（executive/detailed，证据覆盖度质量门）
- **Dashboard**：本地 Web 界面，浏览报告与图表中心（缩略图卡 / 数据集筛选 / 分页 / 大图预览 / 一键复制重跑）、查看本地物化副本（行数漂移、体积变化、精度提示），管理数据字典与指标口径；深浅双主题，暗色为默认
- **外部数据库**：MySQL 远程只读连接（v0.12），SQLite 本地文件；ATTACH 架构，远程表即普通 DuckDB 表，16 个工具可复用；MySQL 全链路已真机验收（v0.14.2），远程表物化见 `materialize_remote_table`

## 工具清单

| 工具 | 用途 |
|------|------|
| load_data | 加载 CSV/Excel 文件为 DuckDB 表（`read_options` 可透传 read_csv_auto 逃生参数：dateformat/types/ignore_errors 等） |
| describe_data | 查看表结构、样例与统计概要 |
| query_data | 执行 SQL 查询（必填 sql + user_intent） |
| transform_data | 建表/物化转换结果 |
| list_datasets | 列出已加载数据集 |
| ask_clarification | 分析方向不明确时主动反问 |
| export_result | 导出查询结果 |
| visualize | 生成统计图表 |
| show_image | 在 TUI 展示图片 |
| connect_database | 连接外部数据库（sqlite 文件 / MySQL 只读远程） |
| confirm_dictionary | 数据字典确认入口 |
| generate_report | 生成正式分析报告 |
| generate_session_report | 生成会话报告 |
| get_table_card | 查询表卡片（用途/边界/字段含义） |
| run_analysis_template | PM 分析模板：funnel 状态漏斗 / cohort 留存分群 / ab_test 双比例检验（确定性统计，v0.13） |
| materialize_remote_table | 远程表物化到本地（只读复制 + 行数熔断 + 原子替换，v0.14） |

### PM 分析模板（v0.13）

`run_analysis_template` 提供三种模板：

- **funnel（状态漏斗）**：2–8 个条件步 + 去重键（`user_key`），可选时间窗口（`time_column` + `window_days`，窗口 = 数据最新时间往前 N 天）。第 k 步 = 满足前 k 步条件**合取**的 distinct user_key（用户级条件叠加，不含步序时间约束）。状态互斥型数据（每行一个 status）不适用——请用分组对比或 cohort。
- **cohort（留存分群）**：`user_key` + `activity_time` + `period`（week/month）+ 可选 `activity_condition`（排除噪声行为）+ `lookback`（默认 12，上限 24）。长期格式输出各群 × 期偏移的留存率与简单平均。
- **ab_test（A/B 双比例检验）**：`variant_column`（恰好 2 个非空取值）+ `success_condition` + `unit`（去重粒度）+ 可选 `segment_columns`（≤3，辛普森扫描）+ `alpha`（默认 0.05）。双侧两比例 z 检验（合并比例），p 值由 TypeScript 确定性正态 CDF 计算（Zelen–Severo 近似，误差 < 1e-7）。内置四项护栏：样本量不足（n<100 或期望计数 <5）、辛普森悖论扫描（段内方向 vs 总体方向）、边缘显著提示（p ∈ (0.01, 0.2)）、效应量（绝对差 + 相对 lift）。

两条统一约束：**统计数值全部由确定性代码计算**，模型只按返回的 method_notes 解释、不得改写或自行计算；映射列触及 `uncertain` 状态字段时**拒绝执行**（fail-closed）。golden 数据集（`src/eval/fixtures/funnel-known.csv`、`cohort-known.csv`）保证统计口径有精确已知答案回归。

## 安装与加载

```bash
# 方式一：作为 Pi 包从 npm 安装（推荐）
pi install npm:pi-data-agent-extension

# 方式二：本地目录安装（开发/未发布场景）
pi install /path/to/pi-data-agent-extension

# 方式三：开发模式显式加载
npm install
npm run build
pi -e /path/to/pi-data-agent-extension/dist/index.js
```

Python 绘图依赖见 `requirements.txt`（matplotlib / pandas / seaborn / numpy / scipy），安装：`pip install -r requirements.txt`。测试继承调用方 PATH，不再注入个人虚拟环境；缺依赖时相关用例会明确 skip 并打印安装命令（不再伪装成测试失败）。历史依赖版本矩阵冲突仍见 `../specs/BACKLOG.md`，本次未验证全新安装。

## 测试

```bash
npm test            # 全量（vitest；2026-10-11 实测 58 文件 / 420 用例：419 passed | 1 skipped，skip 项为缺 Python 绘图依赖时的明确提示）
npm run test:watch  # watch 模式
npm run test:coverage
```

v0.11 起测试统一到 vitest（含 DuckDB 单连接串行约束，singleFork）。

## 数据库连接（v0.12）

`connect_database` 支持两类目标：

```text
# SQLite 本地文件
connect_database(db_type="sqlite", file_path="/path/to/data.db")

# MySQL 远程（只读）
connect_database(db_type="mysql", host="db.internal", port=3306, user="analyst", database="sales")
```

**MySQL 只读语义与配置**：

1. **连接强制 READ_ONLY**（客户端约束）。服务端账号请使用 `GRANT SELECT ONLY`——客户端 READ_ONLY 不是安全边界。写入远程库不支持，此类请求应拒绝。
2. **白名单前置**：只有 `dbAllowedHosts` 白名单内的 host 才允许连接，**默认空 = 拒绝一切远程**。配置方式（二选一）：
   - env：`PI_DATA_AGENT_DB_ALLOWED_HOSTS="db.internal:3306;10.0.0.5"`（分号分隔，支持 `host` 与 `host:port` 两种格式；`localhost` 与 `127.0.0.1` 视为不同目标）
   - config.json（`.pi-data-agent/config.json`）：`{ "dbAllowedHosts": ["db.internal:3306"] }`
3. **凭据三种配置方式**（密码永不作为工具参数——工具参数会整体进入模型上下文）：
   - env `PI_DATA_AGENT_MYSQL_PWD`（项目命名空间，优先）
   - env `MYSQL_PWD`（DuckDB mysql 扩展原生识别）
   - 交互模式下弹出密码输入框（结果仅存入 temporary secret，不落盘）
4. **查询超时**：`dbQueryTimeoutMs`（默认 300000，夹紧 5s~10min），传给 `mysql_query_timeout_max_ms`。超时设置在创建凭据与连接之前，设置失败即拒绝连接；慢查询是否被可靠中断仍需真机验证（见 `../specs/v0.12-EXECUTION_SPEC.md` §12）。
5. **离线环境**：首次连接需下载 mysql/sqlite 扩展（约 10MB）。注意引擎把 `home_directory` 指向项目目录，DuckDB 因此从 `<项目>/.pi-data-agent/.duckdb/extensions/<duckdb版本>/<os>_<arch>/` 找扩展，**`~/.duckdb/extensions` 下的缓存不会被命中**（此时 `INSTALL` 会重新联网，受限网络下直接失败）。离线预置二选一：把缓存复制到上述项目路径，或 `SET extension_directory` 指向已含扩展的目录。连接失败时返回的指引会打印**当前引擎实际查找的目录**。
6. **已知精度坑**：MySQL `DECIMAL(p>38)` 列落地为 DOUBLE（DuckDB 上限 DECIMAL(38)）；`mysql_query()` 表函数因 issue #65 禁用，统一走 ATTACH。

### 远程表物化（v0.14）

`materialize_remote_table` 把已 ATTACH 的远程表**只读复制**到本地 DuckDB（不修改远程数据）：

```text
materialize_remote_table(alias="sales", table="orders")            # 默认本地表名 sales_orders
materialize_remote_table(alias="sales", table="orders", row_limit=100000)
```

- **何时该物化**：大表要反复分析（避免每次跨网查询）、给生产库减压、离线场景。偶尔看几行用 `SELECT * FROM alias.table LIMIT 10` 即可，不需要物化。
- **行数熔断**：先 `COUNT(*)`（下推远端执行），超过 `dbMaxMaterializeRows`（默认 500000，env `PI_DATA_AGENT_DB_MAX_MATERIALIZE_ROWS`）**直接 block**（不是确认）。三条出路：设 `row_limit`、调大阈值、先在远端 WHERE 过滤再物化子集。
- **确认门**：本地写操作走 S-1 fail-closed 确认门——交互模式弹窗（文案含预估行数/目标表/是否替换现有表）；headless 无 `PI_DATA_AGENT_AUTO_CONFIRM_WRITE=true` 即拒绝。
- **原子替换**：tmp → rename 单事务交换；任一步失败自动 ROLLBACK + 清理临时表，已有目标表不受影响、可立即重试。
- **精度坑**：源表 `DECIMAL(p>38)` 落地为 DOUBLE，返回摘要会显式提示（同上 MySQL 精度坑）。
- **物化后**：自动生成数据字典（ai-guessed，用 `confirm_dictionary` 校正）；返回摘要含行数/列数/耗时/endpoint（无凭据）/本地 .duckdb 体积变化。

## 目录结构

```
pi-data-agent-extension/
├── src/
│   ├── index.ts            # Extension 入口（生命周期 + 16 工具注册）
│   ├── config.ts           # 配置加载（env > 项目配置 > 默认值）
│   ├── security.ts         # SQL 安全检查（确认门 fail-closed、路径白名单）
│   ├── persistence.ts      # 配置/字典/记忆持久化
│   ├── error-recovery.ts   # 错误自修复
│   ├── engine/             # DuckDB 引擎 + Python 无状态调用
│   ├── tools/              # 16 个工具实现
│   ├── dashboard/          # 本地 Web Dashboard（server/routes/services/middleware）
│   ├── hooks/              # 数据字典、查询记忆、主动反问
│   ├── navigation/         # L0 导航上下文渲染
│   ├── metrics/            # 指标口径定义
│   ├── report/             # 分析报告生成管线
│   ├── table-cards/        # 表卡片存储
│   ├── llm/                # LLM 调用收敛层
│   └── eval/               # 全部测试（vitest）+ fixtures
├── scripts/                # generate_chart.py / check_python_env.py
└── dist/                   # 构建产物（pi -e 加载入口）
```

## 安全模型

一句话：**写操作确认门 fail-closed（无 UI 环境不静默放行）、SQL 内嵌路径白名单 + 危险操作拦截、模型侧 ATTACH/DETACH 一律拦截（远程连接只允许走 connect_database 工具实现层）、远程目标白名单 fail-closed（默认拒绝一切远程）、凭据不进工具参数/错误文本/审计日志（redactCredentials 兜底）、Dashboard 仅绑定本地回环并叠 Origin 校验 / 速率限制 / 安全响应头 / 写令牌四层中间件。**

## 版本历史

各版本执行规范与交付评审见 `../specs/` 与本目录 `v0.*-REVIEW-REPORT.md` / `v0.*-DELIVERY-REPORT.md`；跨版本欠账统一收录在 `../specs/BACKLOG.md`。
